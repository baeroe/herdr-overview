"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Minimal TOML subset for plugin config: `key = value` top-level lines with
 * string / number / boolean values. Kept tiny on purpose.
 */
function loadConfig(configDir) {
  const defaults = {
    refresh_hz: 4,
    show_space_name: true,
    show_pane_label: true,
    show_cursor: false,
    scale_mode: "compact", // "compact" = blank rows collapsed, long lines wrapped; "crop" = 1:1 live tail; "fit" = decimated thumbnail
    filter: "all", // initial view: "all" spaces, "agents" or "favorites" (one tile per pane)
    monitor_font_size: 7, // font size of the monitor window (toggle-monitor action)
    log_debug: false,
  };
  if (!configDir) return defaults;
  const file = path.join(configDir, "config.toml");
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return defaults;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // strip trailing comment for unquoted values
    if (!value.startsWith('"')) {
      const hash = value.indexOf("#");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (/^".*"$/.test(value)) value = value.slice(1, -1);
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = parseFloat(value);
    if (key in defaults) defaults[key] = value;
  }
  // clamp refresh rate to a sane band (1-10 Hz)
  defaults.refresh_hz = Math.min(10, Math.max(1, Number(defaults.refresh_hz) || 4));
  return defaults;
}

function ensureDir(dir) {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

module.exports = { loadConfig, ensureDir };
