#!/usr/bin/env node
"use strict";

/**
 * "Toggle monitor window" action: run the overview in its own Ghostty window
 * with a small font, so tiles show (almost) whole panes and the window can
 * stay open on a second screen. Triggering it again closes the window.
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { loadConfig, ensureDir } = require("../lib/config");

const STATE_DIR = ensureDir(process.env.HERDR_PLUGIN_STATE_DIR);
const PID_FILE = STATE_DIR ? path.join(STATE_DIR, "monitor.pid") : null;
const config = loadConfig(process.env.HERDR_PLUGIN_CONFIG_DIR);

function runningPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
    if (pid > 0) {
      process.kill(pid, 0); // throws when the process is gone
      return pid;
    }
  } catch {}
  return null;
}

function main() {
  const pid = PID_FILE && runningPid();
  if (pid) {
    process.kill(pid, "SIGTERM"); // the window closes with its command
    return;
  }

  // a fresh terminal does not inherit the plugin environment: pass it on
  const env = Object.entries(process.env)
    .filter(([k]) => k.startsWith("HERDR_") && k !== "HERDR_PANE_ID")
    .map(([k, v]) => `${k}=${v}`);
  const command = [
    "/usr/bin/env",
    ...env,
    "HERDR_OVERVIEW_MONITOR=1",
    process.execPath,
    path.join(__dirname, "overview.js"),
  ];
  const args = [
    `--font-size=${config.monitor_font_size}`,
    "--title=herdr overview",
    "--quit-after-last-window-closed=true",
    "--window-save-state=never",
    "-e",
    ...command,
  ];

  if (process.platform === "darwin") {
    // a second Ghostty instance, so the font size only applies to this window
    const r = spawnSync("open", ["-na", "Ghostty", "--args", ...args], { stdio: "inherit" });
    if (r.status !== 0) {
      process.stderr.write("Could not start Ghostty (is it installed?)\n");
      process.exit(1);
    }
    return;
  }
  const child = spawn("ghostty", args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    process.stderr.write("Could not start ghostty (is it on PATH?)\n");
    process.exit(1);
  });
  child.unref();
}

main();
