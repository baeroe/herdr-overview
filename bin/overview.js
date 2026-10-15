#!/usr/bin/env node
"use strict";

/**
 * Herdr Overview — live tiled mirror of every space (Mission Control).
 *
 * Runs inside a Herdr plugin pane (popup placement). Read-only: source
 * spaces are never moved, resized, or refocused by rendering.
 * Each tile mirrors the focused pane of the space's active tab and follows
 * focus changes automatically, with a per-tile tab bar
 * (focus-only switches, no layout mutation). The "agents" and "favorites"
 * filters switch to one tile per matching pane across all spaces and tabs.
 *
 * Refresh model: independent per-tile refresh loops (no lockstep barrier —
 * each tile re-reads at refresh_hz measured from its own last read start)
 * plus one reconcile loop for topology. Every Herdr request costs ~100ms
 * server-side, so latency is dominated by that round trip; events provide
 * the fast path for lifecycle changes and scrollable output.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { HerdrApi } = require("../lib/api");
const { parseAnsi } = require("../lib/ansi");
const { loadConfig, ensureDir } = require("../lib/config");
const { makeLogger } = require("../lib/log");
const { chooseGrid, tileRect, moveInGrid } = require("../lib/layout");
const { Screen, paintGrid, compactLines, drawTileFrame, paintStatus } = require("../lib/render");
const { subscribe } = require("../lib/socket");

const STATE_DIR = ensureDir(process.env.HERDR_PLUGIN_STATE_DIR);
const STATE_FILE = STATE_DIR ? path.join(STATE_DIR, "overview-state.json") : null;
const config = loadConfig(process.env.HERDR_PLUGIN_CONFIG_DIR);
const log = makeLogger(STATE_DIR, config.log_debug, false); // TUI: never stderr
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = new HerdrApi({ socketPath: process.env.HERDR_SOCKET_PATH });
// True self-exclusion: only for overlay/tab placement where the
// plugin's own pane would mirror itself. Popup placement mirrors everything
// — the pane behind the popup is a real space pane, not the overview.
const ownPaneId = process.env.HERDR_PANE_ID || null;
// Monitor window (bin/monitor.js): stays open after jumping to a pane, and
// leaves a pid file so the action can toggle it.
const MONITOR = process.env.HERDR_OVERVIEW_MONITOR === "1";
const PID_FILE = MONITOR && STATE_DIR ? path.join(STATE_DIR, "monitor.pid") : null;

const out = process.stdout;
const screen = new Screen(out.columns || 80, out.rows || 24);

/** @type {Map<string, object>} workspaceId -> tile */
const tiles = new Map();
let order = []; // workspace ids in server order
let selectedIdx = 0;
const FILTERS = ["all", "agents", "favorites"];
// "all" = one tile per space; "agents"/"favorites" = one tile per pane.
// Toggled with "a"/"F", persisted in state together with the favorites.
let filter = FILTERS.includes(config.filter) ? config.filter : "all";
let favorites = new Set(); // pane ids, toggled with "f"
const paneMode = () => filter !== "all";
// Input mode: keystrokes go to the selected pane ("one", key i) or to every
// pane shown in the overview ("all", key I, sync typing). ctrl+q leaves.
let inputMode = null;
const LEAVE_INPUT = "\x11"; // ctrl+q
const sendQueues = new Map(); // paneId -> { pending: string, busy: boolean }
let lastRects = [];
let lastCols = 1; // columns of the last rendered grid, for up/down
let lastChips = []; // per-tile tab-bar hit rects for mouse
let connected = true;
let closing = false;
let stream = null;
let streamRetryMs = 500;
let subbedPanes = "";
let tabsCache = new Map(); // workspaceId -> [tab records, server order]
let tabsPending = new Set();
let forceReconcile = true;
let lastReconcile = 0;
const tileLoops = new Set(); // workspace ids with a running refresh loop
const lastClick = { tile: -1, at: 0 };

// ---------------------------------------------------------------- lifecycle

function enter() {
  out.write("\x1b[?1049h"); // alt screen
  out.write("\x1b[?25l"); // cursor hidden (pane.read exposes no cursor position)
  out.write("\x1b[?1000h\x1b[?1006h"); // mouse reporting (best effort)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", onInput);
  out.on("resize", onResize);
  process.on("SIGWINCH", onResize);
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);
  restoreState();
  if (PID_FILE) {
    try {
      fs.writeFileSync(PID_FILE, String(process.pid));
    } catch {}
  }
  log.info("overview opened");
  screen.prevDirty = true;
  render();
  reconcileLoop();
  tileLoopPump();
}

function exit() {
  if (closing) return;
  closing = true;
  if (stream) stream.close();
  saveState();
  if (PID_FILE) {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
  }
  out.write("\x1b[?1006l\x1b[?1000l");
  out.write("\x1b[?25h");
  out.write("\x1b[?1049l");
  log.info("overview closed");
  // let pending stdout writes drain before exiting
  setTimeout(() => process.exit(0), 50);
}

function onResize() {
  screen.resize(out.columns || 80, out.rows || 24);
  screen.prevDirty = true;
  render();
}

// ------------------------------------------------------------------- state

function restoreState() {
  try {
    if (STATE_FILE && fs.existsSync(STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      selectedIdx = Math.max(0, s.selectedIdx | 0);
      if (FILTERS.includes(s.filter)) filter = s.filter;
      if (Array.isArray(s.favorites)) favorites = new Set(s.favorites);
    }
  } catch {}
}

function saveState() {
  try {
    if (STATE_FILE) {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ selectedIdx, filter, favorites: [...favorites] }));
    }
  } catch {}
}

/** Switch between space tiles and a pane filter; the choice survives reopening. */
function toggleFilter(name) {
  filter = filter === name ? "all" : name;
  log.info(`filter ${filter}`);
  tiles.clear(); // tile keys differ per mode (space id vs pane id)
  order = [];
  selectedIdx = 0;
  saveState();
  screen.prevDirty = true;
  render();
  reconcileNow();
}

/** Mark or unmark the selected tile's pane as a favorite. */
function toggleFavorite() {
  const key = currentSelection();
  const tile = key && tiles.get(key);
  if (!tile || !tile.paneId) return;
  if (favorites.has(tile.paneId)) favorites.delete(tile.paneId);
  else favorites.add(tile.paneId);
  log.info(`favorite ${tile.paneId} ${favorites.has(tile.paneId) ? "on" : "off"}`);
  saveState();
  render();
  if (filter === "favorites") reconcileNow(); // an unmarked pane drops out
}

function currentSelection() {
  if (order.length === 0) return null;
  return order[Math.min(selectedIdx, order.length - 1)];
}

function moveSelection(dx, dy = 0) {
  if (order.length === 0) return;
  const idx = Math.min(selectedIdx, order.length - 1);
  selectedIdx = moveInGrid(idx, order.length, lastCols, dx, dy);
  render();
}

// ------------------------------------------------------- reconcile + loops

async function reconcileLoop() {
  while (!closing) {
    const due = forceReconcile || Date.now() - lastReconcile > 2000;
    if (due && !closing) {
      forceReconcile = false;
      try {
        const snap = await api.snapshot();
        if (!connected) log.info("observer reconnected");
        connected = true;
        streamRetryMs = 500;
        lastReconcile = Date.now();
        applySnapshot(snap);
        ensureStream();
        tileLoopPump();
      } catch (err) {
        handleDisconnect(err);
      }
    }
    await sleep(60);
  }
}

/** Start refresh loops for any workspace that lacks one; stop dead ones. */
function tileLoopPump() {
  for (const wsId of order) {
    if (!tileLoops.has(wsId)) {
      tileLoops.add(wsId);
      tileLoop(wsId);
    }
  }
  for (const wsId of Array.from(tileLoops)) {
    if (!tiles.has(wsId)) tileLoops.delete(wsId); // loop self-terminates
  }
}

/**
 * Independent per-tile refresh loop: re-read at refresh_hz measured from
 * this tile's own last read START, so slow siblings never delay a tile.
 */
async function tileLoop(wsId) {
  const interval = 1000 / config.refresh_hz;
  while (!closing && tiles.has(wsId)) {
    const t0 = Date.now();
    try {
      await refreshTile(wsId);
    } catch {}
    const wait = Math.max(10, interval - (Date.now() - t0));
    await sleep(wait);
  }
  tileLoops.delete(wsId);
}

function handleDisconnect(err) {
  connected = false;
  log.error(`observer disconnected: ${err.message}`);
  for (const tile of tiles.values()) {
    if (tile.status === "ok" || tile.status === "loading") tile.status = "stale";
  }
  render();
}

/**
 * Persistent event stream: lifecycle events trigger an immediate
 * reconcile, pane.scroll_changed events trigger an immediate tile refresh.
 * Re-opened when the mirrored pane set changes, with backoff on drops.
 */
function ensureStream() {
  const paneIds = order
    .map((wsId) => tiles.get(wsId))
    .filter((t) => t && t.paneId)
    .map((t) => t.paneId)
    .sort()
    .join(",");
  if (stream && paneIds === subbedPanes) return;
  if (stream) {
    stream.close();
    stream = null;
  }
  subbedPanes = paneIds;
  const subs = [
    "workspace.created",
    "workspace.closed",
    "workspace.renamed",
    "workspace.focused",
    "workspace.reordered",
    "tab.created",
    "tab.closed",
    "tab.focused",
    "tab.renamed",
    "pane.created",
    "pane.closed",
    "pane.exited",
    "pane.focused",
    "pane.moved",
    "pane.updated",
  ].map((type) => ({ type }));
  for (const id of paneIds ? paneIds.split(",") : []) {
    subs.push({ type: "pane.scroll_changed", pane_id: id });
  }
  const paneToWs = new Map(
    order.map((wsId) => [tiles.get(wsId)?.paneId, wsId]).filter(([p]) => p)
  );
  subscribe(subs, (msg) => {
    const type = msg.event;
    if (type === "stream.closed") {
      if (closing) return;
      stream = null;
      // reads still work over one-shot connections; only the push hints are
      // gone. Do not mark tiles stale — just rebuild the stream.
      log.error("event stream disconnected; retrying");
      setTimeout(() => {
        if (closing) return;
        streamRetryMs = Math.min(5000, streamRetryMs * 2);
        ensureStream();
      }, streamRetryMs);
      return;
    }
    if (type === "pane.scroll_changed") {
      const wsId = paneToWs.get(msg.data && msg.data.pane_id);
      if (wsId) refreshTile(wsId).catch(() => {});
      return;
    }
    if (type === "pane.updated") {
      // output bursts emit pane_updated floods — a free change hint. Do NOT
      // force a reconcile here (snapshot per burst = request storm).
      const wsId = paneToWs.get(msg.data && msg.data.pane?.pane_id);
      if (wsId) refreshTile(wsId).catch(() => {});
      return;
    }
    if (type.startsWith("tab.") || type.startsWith("workspace.")) {
      tabsCache.clear();
      tabsPending.clear();
    }
    forceReconcile = true; // reconcile loop picks this up within ~60ms
  })
    .then((s) => {
      stream = s;
      log.debug(`event stream open (${subs.length} subscriptions)`);
    })
    .catch((err) => {
      log.error(`event stream failed: ${err.message}`);
      setTimeout(() => {
        if (!closing && !stream) {
          streamRetryMs = Math.min(5000, streamRetryMs * 2);
          ensureStream();
        }
      }, streamRetryMs);
    });
}

// ---------------------------------------------------------------- topology

function applySnapshot(snap) {
  pruneFavorites(snap.panes || []);
  if (filter === "agents") {
    reconcilePanes(snap, (p) => p.agent || p.display_agent);
  } else if (filter === "favorites") {
    reconcilePanes(snap, (p) => favorites.has(p.pane_id));
  } else {
    reconcileTopology(snap.workspaces || [], snap.panes || [], snap.layouts || []);
  }
}

/** Closed panes lose their favorite mark, so a reused pane id starts clean. */
function pruneFavorites(panes) {
  if (!panes.length || !favorites.size) return;
  const alive = new Set(panes.map((p) => p.pane_id));
  let changed = false;
  for (const id of favorites) {
    if (!alive.has(id)) {
      favorites.delete(id);
      changed = true;
    }
  }
  if (changed) saveState();
}

/**
 * Pane mode (agents/favorites filter): one tile per matching pane across
 * every space and tab, keyed by pane id, ordered by space number, tab
 * number, pane order.
 */
function reconcilePanes(snap, matches) {
  const workspaces = snap.workspaces || [];
  const tabs = snap.tabs || [];
  const panes = snap.panes || [];
  const focusedPaneId = snap.focused_pane_id;
  const wsById = new Map(workspaces.map((w) => [w.workspace_id, w]));
  const tabById = new Map(tabs.map((t) => [t.tab_id, t]));
  const matching = panes
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => matches(p) && wsById.has(p.workspace_id))
    .sort((a, b) => {
      const wa = wsById.get(a.p.workspace_id).number;
      const wb = wsById.get(b.p.workspace_id).number;
      if (wa !== wb) return wa - wb;
      const ta = (tabById.get(a.p.tab_id) || {}).number || 0;
      const tb = (tabById.get(b.p.tab_id) || {}).number || 0;
      return ta - tb || a.idx - b.idx;
    })
    .map(({ p }) => p);
  order = [];
  for (const pane of matching) {
    const key = pane.pane_id;
    order.push(key);
    let tile = tiles.get(key);
    if (!tile) {
      tile = { grid: null, hash: null, status: "loading" };
      log.info(`pane discovered ${key}`);
      tiles.set(key, tile);
    }
    const ws = wsById.get(pane.workspace_id);
    const tab = tabById.get(pane.tab_id);
    tile.workspaceId = pane.workspace_id;
    tile.label = ws.label || ws.workspace_id;
    tile.number = ws.number;
    tile.active = pane.pane_id === focusedPaneId;
    tile.tabId = pane.tab_id;
    tile.tabLabel = tab ? tab.label || String(tab.number) : null;
    tile.paneId = pane.pane_id;
    tile.paneLabel = pane.label || null;
    tile.paneAgent = pane.display_agent || pane.agent;
    tile.agentStatus = pane.agent_status || null;
    tile.lastPaneId = pane.pane_id;
  }
  const seen = new Set(order);
  for (const key of Array.from(tiles.keys())) {
    if (!seen.has(key)) {
      tiles.delete(key);
      log.info(`pane removed ${key}`);
    }
  }
  selectedIdx = Math.min(selectedIdx, Math.max(0, order.length - 1));
}

function reconcileTopology(workspaces, panes, layouts) {
  const seen = new Set();
  const sorted = workspaces.slice().sort((a, b) => a.number - b.number);
  const layoutByTab = new Map(layouts.map((l) => [l.tab_id, l]));
  order = [];
  for (const ws of sorted) {
    seen.add(ws.workspace_id);
    order.push(ws.workspace_id);
    // mirror target: the pane focused inside the space's active tab
    // (session-wide pane.focused only covers the foreground tab, so the tab
    // layout snapshot is authoritative here)
    const activeTab = ws.active_tab_id;
    const layout = layoutByTab.get(activeTab);
    let focusedPaneId = layout ? layout.focused_pane_id : null;
    if (!focusedPaneId) {
      const tabPanes = panes.filter((p) => p.tab_id === activeTab);
      focusedPaneId = tabPanes.length ? tabPanes[0].pane_id : null;
    }
    const pane = focusedPaneId
      ? panes.find((p) => p.pane_id === focusedPaneId)
      : null;
    let tile = tiles.get(ws.workspace_id);
    if (!tile) {
      tile = { grid: null, hash: null };
      log.info(`space discovered ${ws.workspace_id} "${ws.label}"`);
      tiles.set(ws.workspace_id, tile);
    }
    tile.workspaceId = ws.workspace_id;
    tile.label = ws.label || ws.workspace_id;
    tile.number = ws.number;
    tile.active = !!ws.focused;
    tile.tabId = activeTab;
    tile.paneId = pane ? pane.pane_id : focusedPaneId;
    tile.paneLabel = pane ? pane.label : null;
    tile.paneAgent = pane ? pane.display_agent || pane.agent : null;
    tile.agentStatus = pane ? pane.agent_status || null : null;
    if (tile.lastPaneId !== tile.paneId) {
      // mirror target changed (focus or tab moved inside the source space)
      tile.grid = null;
      tile.hash = null;
      tile.status = "loading";
      tile.lastPaneId = tile.paneId;
    }
    if (tile.status === undefined) tile.status = "loading";
  }
  for (const wsId of Array.from(tiles.keys())) {
    if (!seen.has(wsId)) {
      tiles.delete(wsId);
      log.info(`space removed ${wsId}`);
    }
  }
  selectedIdx = Math.min(selectedIdx, Math.max(0, order.length - 1));
}

// ------------------------------------------------------------------ reads

async function refreshTile(wsId) {
  const tile = tiles.get(wsId);
  if (!tile || closing) return;
  if (!tile.paneId) {
    tile.status = "empty";
    return;
  }
  if (ownPaneId && tile.paneId === ownPaneId) {
    tile.status = "self";
    render(); // exclusion is a visible state change
    return;
  }
  // coalesce: at most one in-flight read per tile, min 80ms apart, so
  // pane_updated bursts cannot become request storms
  const now = Date.now();
  if (tile.inFlight) {
    tile.pending = true;
    return;
  }
  if (now - (tile.lastRead || 0) < 80) return;
  tile.inFlight = true;
  tile.lastRead = now;
  try {
    const read = await api.paneRead(tile.paneId, "ansi");
    if (!read.text.trim()) {
      log.info(`blank viewport read for ${tile.paneId}`);
    }
    if (read.text !== tile.hash) {
      tile.hash = read.text;
      tile.grid = parseAnsi(read.text);
      tile.status = "ok";
      render();
    } else if (tile.status !== "ok") {
      tile.status = "ok";
      render();
    }
  } catch (err) {
    const code = err instanceof Error && err.code ? err.code : "error";
    tile.status = code === "not_found" ? "closed" : "unavailable";
    tile.error = err.message;
    render();
  } finally {
    tile.inFlight = false;
    if (tile.pending) {
      tile.pending = false;
      refreshTile(wsId).catch(() => {});
    }
  }
}

// ------------------------------------------------------------------- input

function onInput(data) {
  const str = data.toString("utf8");
  if (inputMode) {
    forwardInput(str);
    return;
  }
  let i = 0;
  while (i < str.length) {
    const rest = str.slice(i);
    if (rest.startsWith("\x1b[<")) {
      const m = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (!m) break;
      handleMouse(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m[4]);
      i += m[0].length;
      continue;
    }
    if (rest.startsWith("\x1b[")) {
      const m = rest.match(/^\x1b\[([A-DH])/);
      if (m) {
        const key = m[1];
        if (key === "A") moveSelection(0, -1);
        else if (key === "B") moveSelection(0, 1);
        else if (key === "C") moveSelection(1);
        else if (key === "D") moveSelection(-1);
        i += m[0].length;
        continue;
      }
      // unhandled CSI: skip the sequence
      const m2 = rest.match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      i += m2 ? m2[0].length : 2;
      continue;
    }
    const ch = str[i];
    if (ch === "\x1b") {
      // lone Escape (not a sequence) closes the overview
      if (str.length - i === 1) exit();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      enterSelection();
    } else if (ch >= "1" && ch <= "9") {
      const idx = ch.charCodeAt(0) - 49;
      if (idx < order.length) {
        selectedIdx = idx;
        render();
        enterSelection();
      }
    } else if (ch === "[" || ch === ",") {
      switchTab(-1);
    } else if (ch === "]" || ch === ".") {
      switchTab(1);
    } else if (ch === "k") moveSelection(0, -1);
    else if (ch === "j") moveSelection(0, 1);
    else if (ch === "h") moveSelection(-1);
    else if (ch === "l") moveSelection(1);
    else if (ch === "q") exit();
    else if (ch === "a") toggleFilter("agents");
    else if (ch === "F") toggleFilter("favorites");
    else if (ch === "f") toggleFavorite();
    else if (ch === "i") setInputMode("one");
    else if (ch === "I") setInputMode("all");
    i += 1;
  }
}

function handleMouse(button, x, y, kind) {
  if (kind !== "M") return; // only press events
  if ((button & 64) !== 0) return; // wheel
  if ((button & 3) !== 0) return; // only left button
  // SGR mouse coordinates are 1-based; our rects are 0-based
  x -= 1;
  y -= 1;
  // per-tile tab chips
  const chip = lastChips.find((c) => y === c.y && x >= c.x0 && x < c.x1);
  if (chip) {
    selectedIdx = chip.tile;
    switchChip(chip.wsId, chip.tabId);
    return;
  }
  const hit = lastRects.findIndex(
    (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
  );
  if (hit < 0) return;
  selectedIdx = hit;
  render();
  const now = Date.now();
  if (lastClick.tile === hit && now - lastClick.at < 400) {
    enterSelection(); // double click enters
    lastClick.tile = -1;
    return;
  }
  lastClick.tile = hit;
  lastClick.at = now;
}

// ------------------------------------------------------------------ typing

function setInputMode(mode) {
  if (mode && order.length === 0) return;
  inputMode = mode;
  log.info(`input mode ${mode || "off"}`);
  render();
}

/** Panes that receive typed input: the selected one, or every tile's pane. */
function inputTargets() {
  const keys = inputMode === "all" ? order : [currentSelection()];
  return keys
    .map((key) => tiles.get(key))
    .filter((t) => t && t.paneId && t.paneId !== ownPaneId && t.status !== "closed")
    .map((t) => t.paneId);
}

/**
 * Forward raw terminal input to the target panes. Mouse reports still
 * select tiles (in "one" mode the input follows the selection); ctrl+q
 * leaves input mode, everything else (Esc and ctrl+c included) is sent.
 */
function forwardInput(str) {
  let text = "";
  let i = 0;
  while (i < str.length) {
    const rest = str.slice(i);
    const m = rest.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (m) {
      handleMouse(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m[4]);
      i += m[0].length;
      continue;
    }
    if (str[i] === LEAVE_INPUT) {
      sendToTargets(text);
      setInputMode(null);
      // anything typed after ctrl+q in the same chunk is a normal key again
      if (i + 1 < str.length) onInput(Buffer.from(str.slice(i + 1), "utf8"));
      return;
    }
    text += str[i];
    i += 1;
  }
  sendToTargets(text);
}

function sendToTargets(text) {
  if (!text) return;
  for (const paneId of inputTargets()) sendText(paneId, text);
}

/** Per-pane send queue: keeps keystroke order, batches fast typing. */
function sendText(paneId, text) {
  let q = sendQueues.get(paneId);
  if (!q) {
    q = { pending: "", busy: false };
    sendQueues.set(paneId, q);
  }
  q.pending += text;
  if (q.busy) return;
  const flush = async () => {
    q.busy = true;
    while (q.pending && !closing) {
      const chunk = q.pending;
      q.pending = "";
      try {
        await api.paneSendText(paneId, chunk);
      } catch (err) {
        log.error(`send to ${paneId} failed: ${err.message}`);
      }
      const key = order.find((k) => tiles.get(k)?.paneId === paneId);
      if (key) refreshTile(key).catch(() => {}); // show the echo right away
    }
    q.busy = false;
  };
  flush();
}

// ------------------------------------------------------------ tab actions

/** Kick an immediate reconcile (bounded so parallel calls coalesce). */
let reconciling = false;
async function reconcileNow() {
  if (reconciling || closing) return;
  reconciling = true;
  try {
    const snap = await api.snapshot();
    connected = true;
    lastReconcile = Date.now();
    applySnapshot(snap);
    ensureStream();
    tileLoopPump();
  } catch {}
  reconciling = false;
}

/** Click a tab chip: focus that tab (focus-only, no layout change). */
async function switchChip(wsId, tabId) {
  try {
    await api.tabFocus(tabId);
    log.info(`tab chip -> ${tabId} in ${wsId}`);
    await reconcileNow();
  } catch (err) {
    log.error(`tab focus failed: ${err.message}`);
  }
}

/**
 * Switch the selected space's active tab: focus-only,
 * no pane/layout mutation. The tile follows the newly active tab's
 * focused pane as soon as the reconcile lands.
 */
async function switchTab(delta) {
  if (paneMode()) return; // tiles are panes, not spaces
  const wsId = currentSelection();
  const tile = wsId && tiles.get(wsId);
  if (!wsId || !tile || !tile.tabId) return;
  let tabs = tabsCache.get(wsId);
  if (!tabs) {
    try {
      tabs = await api.tabList(wsId);
      tabsCache.set(wsId, tabs);
    } catch {
      return;
    }
  }
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.tab_id === tile.tabId);
  const next = tabs[(idx + delta + tabs.length) % tabs.length];
  if (!next || next.tab_id === tile.tabId) return;
  try {
    await api.tabFocus(next.tab_id);
    log.info(`switched ${wsId} tab -> ${next.tab_id} ("${next.label}")`);
    await reconcileNow();
  } catch (err) {
    log.error(`tab focus failed: ${err.message}`);
  }
}

/**
 * Enter the selected space: focus the source workspace, then close the
 * overview popup. Focus is applied by a short-lived detached helper so the
 * popup close cannot clobber it (no layout mutation).
 */
function enterSelection() {
  const key = currentSelection();
  const tile = key && tiles.get(key);
  if (!tile) return;
  const wsId = tile.workspaceId;
  // pane mode also jumps to the agent's tab and pane
  const calls = [["workspace.focus", { workspace_id: wsId }]];
  if (paneMode()) {
    calls.push(["tab.focus", { tab_id: tile.tabId }], ["pane.focus", { pane_id: tile.paneId }]);
  }
  log.info(`enter ${paneMode() ? `pane ${tile.paneId} in ` : ""}space ${wsId}`);
  // one request per connection: the server treats plain connections as one-shot
  const script = `
    const net=require("node:net");
    const [sockPath,callsJson]=process.argv.slice(1);
    const calls=JSON.parse(callsJson);
    const send=(i)=>{
      if(i>=calls.length)return process.exit(0);
      const s=net.connect(sockPath);
      s.on("connect",()=>s.write(JSON.stringify({id:"f"+i,method:calls[i][0],params:calls[i][1]})+"\\n"));
      s.on("data",()=>{s.destroy();send(i+1);});
      s.on("error",()=>process.exit(1));
    };
    send(0);
    setTimeout(()=>process.exit(1),3000);
  `;
  try {
    const child = spawn(
      process.execPath,
      ["-e", script, api.socketPath, JSON.stringify(calls)],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
  } catch (err) {
    log.error(`focus helper failed: ${err.message}`);
  }
  if (!MONITOR) setTimeout(exit, 80); // the monitor window keeps watching
}

// ----------------------------------------------------------------- render

function tileLabel(tile) {
  const star = favorites.has(tile.paneId) ? "★ " : "";
  return star + baseLabel(tile);
}

function baseLabel(tile) {
  if (paneMode()) {
    const parts = [];
    if (config.show_space_name) parts.push(tile.tabLabel ? `${tile.label} › ${tile.tabLabel}` : tile.label);
    if (config.show_pane_label) parts.push(tile.paneLabel || tile.paneAgent);
    // the agent state is drawn as a coloured dot in front of the label
    return parts.filter(Boolean).join(" · ");
  }
  let label = config.show_space_name ? tile.label : "";
  if (config.show_pane_label && tile.paneLabel) {
    label = label ? `${label} / ${tile.paneLabel}` : tile.paneLabel;
  } else if (config.show_pane_label && tile.paneAgent && !tile.paneLabel) {
    label = label ? `${label} / ${tile.paneAgent}` : tile.paneAgent;
  }
  return label;
}

function render() {
  screen.clear();
  const W = screen.width;
  const H = screen.height;
  const area = { x: 0, y: 0, w: W, h: Math.max(0, H - 1) }; // footer row

  lastRects = [];
  lastChips = [];
  if (order.length === 0) {
    const msg = connected
      ? filter === "agents"
        ? "No agents running — a shows all spaces"
        : filter === "favorites"
          ? "No favorites yet — a/F back, f marks the selected pane"
          : "No spaces found"
      : "Herdr connection lost — reconnecting…";
    paintStatus(screen, { x: 0, y: 0, w: W, h: Math.max(1, H) }, msg);
  } else {
    const grid = chooseGrid(order.length, area.w, area.h);
    lastCols = grid.cols;
    for (let i = 0; i < order.length; i++) {
      const tile = tiles.get(order[i]);
      if (!tile) continue;
      const rect = tileRect(i, grid, area.x, area.y, area.w, area.h);
      lastRects[i] = rect;
      const selected = i === Math.min(selectedIdx, order.length - 1);
      let label = tileLabel(tile);
      const mode = ["crop", "fit"].includes(config.scale_mode) ? config.scale_mode : "compact";
      if (tile.status === "ok" && tile.grid) {
        const cropped =
          mode === "compact"
            ? compactLines(tile.grid, rect.w - 2).length > rect.h - 2
            : tile.grid.rows > rect.h - 2 || tile.grid.cols > rect.w - 2;
        if (cropped) label += " ⋮"; // only the live tail fits
      }
      drawTileFrame(screen, rect, {
        label,
        selected,
        active: tile.active,
        status: tile.agentStatus,
        input: inputMode === "all" || (inputMode === "one" && selected),
      });
      // native-style tab strip along the tile's top edge
      drawTileTabs(rect, i, tile);
      if (tile.status === "ok" && tile.grid) {
        paintGrid(screen, rect, tile.grid, mode);
      } else if (tile.status === "self") {
        paintStatus(screen, rect, "« this overview »");
      } else if (tile.status === "closed") {
        paintStatus(screen, rect, "Pane closed");
      } else if (tile.status === "stale") {
        paintStatus(screen, rect, "Preview stale — reconnecting");
      } else if (tile.status === "unavailable") {
        paintStatus(screen, rect, "Preview unavailable");
      } else if (tile.status === "empty") {
        paintStatus(screen, rect, "No panes in space");
      } else {
        paintStatus(screen, rect, "Loading preview…");
      }
    }
    ensureTabsForTiles();
  }

  if (inputMode) {
    const n = inputTargets().length;
    const target =
      inputMode === "all"
        ? `all ${n} pane${n === 1 ? "" : "s"}`
        : tileLabel(tiles.get(currentSelection()) || {}) || "selected pane";
    const bar = ` TYPING → ${target} · ctrl+q stop typing `;
    screen.putText(0, H - 1, bar.slice(0, W), { bold: true, reverse: true, fg: { kind: "ansi", n: 5 } });
  } else {
    const hint =
      (filter === "all"
        ? "←↑↓→ select · ↵ enter · i type · I type in all · f favorite · a agents · F favorites · [/] tab · esc close"
        : `←↑↓→ select · ↵ jump to pane · i type · I type in all · f favorite · ${
            filter === "agents" ? "a all spaces · F favorites" : "F all spaces · a agents"
          } · esc close`) + (connected ? "" : "  [offline]");
    screen.putText(0, H - 1, hint.slice(0, W), { dim: true, italic: true });
  }

  const frame = screen.flush();
  if (frame) {
    log.debug(`frame ${frame.length} bytes`);
    // synchronized update: prevents visible tearing on slow terminals
    out.write("\x1b[?2026h" + frame + "\x1b[?2026l");
  }
}

/**
 * Native-style tab strip along the tile's top border: numbered chips sitting
 * in the frame, active tab inverted. Chips are mouse-clickable (hit rects
 * carry the owning tile so a click also selects the tile).
 */
function drawTileTabs(rect, tileIdx, tile) {
  if (paneMode()) return;
  const tabs = tabsCache.get(tile.workspaceId) || [];
  if (!tabs.length) return;
  const y = rect.y;
  // reserve room for the label on the left and the frame corners
  let xEnd = rect.x + rect.w - 2;
  const borderAttrs = { dim: true };
  for (let i = tabs.length - 1; i >= 0 && xEnd > rect.x + 2; i--) {
    const t = tabs[i];
    const isActive = t.tab_id === tile.tabId;
    const num = String(t.number || i + 1);
    let name = t.label && t.label !== num ? ` ${t.label}` : "";
    let chip = ` ${num}${name} `;
    if (chip.length > xEnd - rect.x - 2) {
      chip = chip.slice(0, Math.max(1, xEnd - rect.x - 2));
    }
    const x0 = xEnd - chip.length;
    screen.putText(x0, y, chip, isActive ? { bold: true, reverse: true } : borderAttrs);
    lastChips.push({ y, x0, x1: xEnd, tabId: t.tab_id, wsId: tile.workspaceId, tile: tileIdx });
    xEnd = x0;
    if (xEnd > rect.x + 2) {
      screen.putText(xEnd - 1, y, " ", { dim: true });
      xEnd -= 1;
    }
  }
}

/** Lazily fetch tabs for every visible space so the bars can render. */
function ensureTabsForTiles() {
  if (paneMode()) return;
  for (const wsId of order) {
    if (tabsCache.has(wsId) || tabsPending.has(wsId)) continue;
    tabsPending.add(wsId);
    api
      .tabList(wsId)
      .then((tabs) => {
        tabsCache.set(wsId, tabs);
        render();
      })
      .catch(() => {})
      .finally(() => tabsPending.delete(wsId));
  }
}

enter();
