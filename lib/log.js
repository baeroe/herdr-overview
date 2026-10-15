"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Lightweight debug logging to the plugin state dir. */
function makeLogger(stateDir, debug, useStderr = true) {
  const file = stateDir ? path.join(stateDir, "overview.log") : null;
  if (file) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
    } catch {}
  }
  const write = (level, msg) => {
    if (level === "debug" && !debug) return;
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    try {
      if (file) fs.appendFileSync(file, line);
      // stderr is only safe for one-shot commands; inside the popup TUI it
      // would paint straight onto the alt screen
      if (level === "error" && useStderr) process.stderr.write(line);
    } catch {}
  };
  return {
    debug: (m) => write("debug", m),
    info: (m) => write("info", m),
    error: (m) => write("error", m),
  };
}

module.exports = { makeLogger };
