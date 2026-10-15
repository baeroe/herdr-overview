"use strict";

const { parseAnsi, defaultCell, cloneCell } = require("./ansi");

/**
 * Terminal screen buffer with damage-based output: the frame is
 * composed into a cell buffer, diffed against the previous frame, and only
 * changed cells are written.
 */

function sgrReset() {
  return "\x1b[0m";
}

function sgrBetween(prev, cell) {
  let out = "";
  const changed = (a, b) => a !== b;
  if (
    !prev ||
    changed(prev.fg && prev.fg.kind, cell.fg && cell.fg.kind) ||
    changed(prev.fg && prev.fg.n, cell.fg && cell.fg.n) ||
    changed(prev.fg && prev.fg.r, cell.fg && cell.fg.r) ||
    changed(prev.bg && prev.bg.kind, cell.bg && cell.bg.kind) ||
    changed(prev.bg && prev.bg.n, cell.bg && cell.bg.n) ||
    changed(prev.bold, cell.bold) ||
    changed(prev.dim, cell.dim) ||
    changed(prev.italic, cell.italic) ||
    changed(prev.underline, cell.underline) ||
    changed(prev.reverse, cell.reverse)
  ) {
    out += sgrReset();
    if (cell.bold) out += "\x1b[1m";
    if (cell.dim) out += "\x1b[2m";
    if (cell.italic) out += "\x1b[3m";
    if (cell.underline) out += "\x1b[4m";
    if (cell.reverse) out += "\x1b[7m";
    if (cell.fg) {
      if (cell.fg.kind === "ansi") {
        const n = cell.fg.n;
        out += n < 8 ? `\x1b[${30 + n}m` : `\x1b[${90 + n - 8}m`;
      } else if (cell.fg.kind === "rgb") {
        out += `\x1b[38;2;${cell.fg.r};${cell.fg.g};${cell.fg.b}m`;
      }
    }
    if (cell.bg) {
      if (cell.bg.kind === "ansi") {
        const n = cell.bg.n;
        out += n < 8 ? `\x1b[${40 + n}m` : `\x1b[${100 + n - 8}m`;
      } else if (cell.bg.kind === "rgb") {
        out += `\x1b[48;2;${cell.bg.r};${cell.bg.g};${cell.bg.b}m`;
      }
    }
    return out;
  }
  return out;
}

function attrsEqual(a, b) {
  if (!a || !b) return false;
  const sameColor = (x, y) =>
    x === y ||
    (x && y && x.kind === y.kind && x.n === y.n && x.r === y.r && x.g === y.g && x.b === y.b);
  return (
    sameColor(a.fg, b.fg) &&
    sameColor(a.bg, b.bg) &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.reverse === b.reverse
  );
}

class Screen {
  constructor(width, height) {
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.buf = makeBuffer(width, height);
    this.prev = makeBuffer(width, height);
    this.prevDirty = true;
  }

  clear() {
    const blank = defaultCell();
    for (let y = 0; y < this.height; y++) {
      const row = this.buf[y];
      for (let x = 0; x < this.width; x++) row[x] = cloneCell(blank);
    }
  }

  put(x, y, cell) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.buf[y][x] = cell;
  }

  putText(x, y, text, attrs = {}) {
    let cx = x;
    for (const ch of Array.from(text)) {
      const c = defaultCell();
      c.ch = ch;
      Object.assign(c, attrs);
      this.put(cx, y, c);
      cx += 1;
    }
    return cx;
  }

  /** Diff-composed frame into an ANSI string. Returns null if unchanged. */
  flush() {
    let out = this.prevDirty ? "\x1b[2J" : "";
    let lastAttr = null;
    let curX = -1;
    let curY = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.buf[y][x];
        const prev = this.prev[y][x];
        if (!this.prevDirty && prev.ch === cell.ch && attrsEqual(prev, cell)) continue;
        if (x !== curX || y !== curY) {
          out += `\x1b[${y + 1};${x + 1}H`;
          curX = x;
          curY = y;
        }
        const s = sgrBetween(lastAttr, cell);
        if (s) out += s;
        lastAttr = cell;
        out += cell.ch === "" ? " " : cell.ch;
        curX += 1;
      }
    }
    // swap buffers
    const tmp = this.prev;
    this.prev = this.buf;
    this.buf = tmp;
    this.prevDirty = false;
    // clear this.buf for next compose
    this.clear();
    return out.length > 0 || this.prevDirty ? out + sgrReset() : null;
  }
}

function makeBuffer(w, h) {
  const buf = new Array(h);
  const blank = defaultCell();
  for (let y = 0; y < h; y++) {
    const row = new Array(w);
    for (let x = 0; x < w; x++) row[x] = cloneCell(blank);
    buf[y] = row;
  }
  return buf;
}

/**
 * Paint a mirrored viewport into the screen inside a rect.
 *
 * Text cannot be font-scaled in a cell grid, so proportional decimation
 * turns words into gibberish. Default strategy is therefore a 1:1 crop
 * anchored to the bottom of the viewport (the live tail: prompt, latest
 * output, errors, agent input box). Viewports that fit are rendered 1:1
 * centred. mode="fit" keeps the proportional decimation thumbnail instead
 * (readability vs coverage trade-off).
 */
function paintGrid(screen, rect, grid, mode = "crop") {
  const inner = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 };
  if (inner.w <= 0 || inner.h <= 0 || !grid) return;
  const gw = grid.cols || 1;
  const gh = grid.rows || 1;

  if (mode === "fit" && (gw > inner.w || gh > inner.h)) {
    for (let y = 0; y < inner.h; y++) {
      for (let x = 0; x < inner.w; x++) {
        const sx = Math.min(gw - 1, Math.floor((x + 0.5) * (gw / inner.w)));
        const sy = Math.min(gh - 1, Math.floor((y + 0.5) * (gh / inner.h)));
        const src = grid.cells[sy] ? grid.cells[sy][sx] : null;
        screen.put(inner.x + x, inner.y + y, src ? cloneCell(src) : defaultCell());
      }
    }
    return;
  }

  if (gw <= inner.w && gh <= inner.h) {
    // fits: 1:1, bottom-left anchored — like a real terminal, blank space
    // grows upward and the cursor side stays at the bottom
    const offX = 0;
    const offY = inner.h - gh;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const src = grid.cells[y] ? grid.cells[y][x] : null;
        if (src) screen.put(inner.x + offX + x, inner.y + offY + y, cloneCell(src));
      }
    }
    return;
  }

  // crop: 1:1, bottom-left anchored — the live tail (latest rows) with
  // line starts preserved so prompts stay visible
  const startRow = Math.max(0, gh - inner.h);
  for (let y = 0; y < Math.min(inner.h, gh); y++) {
    const srcRow = grid.cells[startRow + y] || [];
    for (let x = 0; x < Math.min(inner.w, gw); x++) {
      const src = srcRow[x];
      if (src) screen.put(inner.x + x, inner.y + y, cloneCell(src));
    }
  }
}

const BORDER = {
  normal: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  selected: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
};

/**
 * Draw a tile frame with a one-line header inside the top border.
 * @param {Screen} screen
 * @param {{x,y,w,h}} rect
 * @param {{label:string, selected:boolean, active:boolean, dimmed:boolean}} opts
 */
function drawTileFrame(screen, rect, opts) {
  if (rect.w < 4 || rect.h < 3) return;
  const style = opts.selected ? BORDER.selected : BORDER.normal;
  const attrs = { dim: !opts.selected, bold: opts.selected };
  const top = style.h.repeat(rect.w - 2);
  screen.putText(rect.x, rect.y, style.tl, attrs);
  screen.putText(rect.x + 1, rect.y, top, attrs);
  screen.putText(rect.x + rect.w - 1, rect.y, style.tr, attrs);

  // header: " ● API / codex " fitted into the top border
  let label = opts.label || "";
  const maxLen = rect.w - 4;
  if (label.length > maxLen) label = label.slice(0, maxLen);
  const labelAttrs = { bold: true, dim: false, underline: false, reverse: false };
  if (label && maxLen > 1) {
    const lx = rect.x + 2;
    // carve space in the top border for the label
    for (let x = lx; x < lx + label.length + 1 && x < rect.x + rect.w - 1; x++) {
      screen.put(x, rect.y, { ...defaultCell(), ch: style.h, ...attrs });
    }
    let cx = lx;
    if (opts.active) {
      cx = screen.putText(cx, rect.y, "●", { ...labelAttrs });
    }
    screen.putText(cx, rect.y, label ? ` ${label}` : "", labelAttrs);
  }

  screen.putText(rect.x, rect.y + rect.h - 1, style.bl, attrs);
  screen.putText(rect.x + 1, rect.y + rect.h - 1, style.h.repeat(rect.w - 2), attrs);
  screen.putText(rect.x + rect.w - 1, rect.y + rect.h - 1, style.br, attrs);
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    screen.putText(rect.x, y, style.v, attrs);
    screen.putText(rect.x + rect.w - 1, y, style.v, attrs);
  }
}

/**
 * Paint a status message (preview unavailable, pane closed, overview...) in
 * the middle of a tile.
 */
function paintStatus(screen, rect, message) {
  const inner = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 };
  if (inner.w <= 0 || inner.h <= 0) return;
  const msg = message.length > inner.w ? message.slice(0, inner.w) : message;
  const x = inner.x + Math.floor((inner.w - msg.length) / 2);
  const y = inner.y + Math.floor(inner.h / 2);
  screen.putText(x, y, msg, { dim: true, italic: true });
}

module.exports = { Screen, paintGrid, drawTileFrame, paintStatus, sgrBetween, attrsEqual };
