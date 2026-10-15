"use strict";

const { request, defaultSocketPath, SocketError } = require("./socket");

/**
 * Typed helpers over the Herdr socket API. Every call opens its own
 * connection because the server treats non-subscription connections as
 * one-shot. All calls are read-only except focus/popup helpers.
 */
class HerdrApi {
  constructor(opts = {}) {
    this.socketPath = opts.socketPath || defaultSocketPath();
    this.timeoutMs = opts.timeoutMs || 5000;
  }

  _req(method, params) {
    return request(method, params, {
      socketPath: this.socketPath,
      timeoutMs: this.timeoutMs,
    });
  }

  async ping() {
    const r = await this._req("ping", {});
    return r;
  }

  /** @returns {Promise<Array>} workspace records in server order */
  async workspaceList() {
    const r = await this._req("workspace.list", {});
    return r.workspaces || [];
  }

  /** @returns {Promise<Array>} tab records for a workspace, server order */
  async tabList(workspaceId) {
    const r = await this._req("tab.list", { workspace_id: workspaceId });
    return r.tabs || [];
  }

  /** Focus a specific tab inside its workspace (focus-only, no layout change). */
  async tabFocus(tabId) {
    return this._req("tab.focus", { tab_id: tabId });
  }

  /** @returns {Promise<Array>} pane records for the whole session */
  async paneList() {
    const r = await this._req("pane.list", {});
    return r.panes || [];
  }

  /**
   * Read the currently rendered viewport of a pane.
   * @param {string} paneId
   * @param {"text"|"ansi"} [format]
   * @returns {Promise<{text:string, revision:number, truncated:boolean}>}
   */
  async paneRead(paneId, format = "ansi") {
    const r = await this._req("pane.read", {
      pane_id: paneId,
      source: "visible",
      format,
    });
    const read = r.read || r;
    return {
      text: read.text,
      revision: read.revision,
      truncated: read.truncated,
    };
  }

  /** @returns {Promise<object>} live session snapshot */
  async snapshot() {
    const r = await this._req("session.snapshot", {});
    return r.snapshot || r;
  }

  /** Focus a workspace (its active tab and focused pane keep their state). */
  /** Write raw input (text, control keys, escape sequences) into a pane. */
  async paneSendText(paneId, text) {
    return this._req("pane.send_text", { pane_id: paneId, text });
  }

  async workspaceFocus(workspaceId) {
    return this._req("workspace.focus", { workspace_id: workspaceId });
  }

  /**
   * Open this plugin's overview pane. Prefers popup placement (session-modal,
   * no pane id, restores focus on close). Rejects with a SocketError whose
   * message contains "popup already open" when the popup is already showing.
   */
  async openOverview(pluginId, entrypoint = "overview") {
    return this._req("plugin.pane.open", {
      plugin_id: pluginId,
      entrypoint,
      placement: "popup",
      width: "94%",
      height: "94%",
      focus: true,
    });
  }

  async closePopup() {
    return this._req("popup.close", {});
  }
}

module.exports = { HerdrApi, SocketError };
