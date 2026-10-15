#!/usr/bin/env node
"use strict";

/**
 * "Toggle Spaces Overview" action: open the overview popup, or
 * close it when it is already showing. The popup is a singleton session
 * resource, so Herdr rejects a second open with "popup already open".
 */

const { HerdrApi } = require("../lib/api");

const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "herdr-overview";
const ENTRYPOINT = "overview";

async function main() {
  const api = new HerdrApi();
  try {
    await api.openOverview(PLUGIN_ID, ENTRYPOINT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/popup already open/i.test(msg)) {
      await api.closePopup();
      return;
    }
    if (/ui_busy/i.test(msg)) {
      process.stderr.write("Herdr UI is busy (a modal is open). Try again.\n");
      process.exit(1);
    }
    process.stderr.write(`Failed to open overview: ${msg}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Failed to open overview: ${err.message}\n`);
  process.exit(1);
});
