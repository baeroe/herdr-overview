"use strict";

/**
 * Minimal newline-delimited JSON-RPC client for the Herdr socket API.
 *
 * Herdr closes a raw connection shortly after a request/response round trip
 * unless the connection holds an event subscription stream. Requests are
 * therefore one-shot by design: connect, send, await response, destroy.
 */

const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

function defaultSocketPath() {
  if (process.env.HERDR_SOCKET_PATH) {
    return expandHome(process.env.HERDR_SOCKET_PATH);
  }
  if (process.env.HERDR_SESSION) {
    return expandHome(
      `~/.config/herdr/sessions/${process.env.HERDR_SESSION}/herdr.sock`
    );
  }
  return expandHome("~/.config/herdr/herdr.sock");
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

class SocketError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SocketError";
    this.code = code || "socket_error";
  }
}

/**
 * Send a single request on a fresh connection.
 * @param {string} method
 * @param {object} params
 * @param {{socketPath?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<object>} result payload (throws SocketError on error response)
 */
function request(method, params, opts = {}) {
  const socketPath = opts.socketPath || defaultSocketPath();
  const timeoutMs = opts.timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = "";
    const sock = net.connect(socketPath);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new SocketError(`request ${method} timed out`, "timeout"));
    }, timeoutMs);

    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: "req", method, params }) + "\n");
    });

    sock.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) {
          finish(
            reject,
            new SocketError(msg.error.message || "request failed", msg.error.code)
          );
          return;
        }
        if (msg.result) {
          finish(resolve, msg.result);
          return;
        }
      }
    });

    sock.on("error", (err) => {
      finish(reject, new SocketError(err.message, "connect_error"));
    });
    sock.on("close", () => {
      if (!settled) {
        finish(reject, new SocketError("connection closed before response", "closed"));
      }
    });
  });
}

/**
 * Open a persistent event-subscription stream. Subscription connections are
 * the only connections the server keeps open; requests sent on them are
 * rejected, so this stream is for events only.
 *
 * @param {Array<{type:string, pane_id?:string}>} subscriptions
 * @param {(event:{event:string, data:object}) => void} onEvent
 * @param {{socketPath?: string}} [opts]
 * @returns {Promise<{close: () => void}>}
 */
function subscribe(subscriptions, onEvent, opts = {}) {
  const socketPath = opts.socketPath || defaultSocketPath();
  return new Promise((resolve, reject) => {
    let buf = "";
    const sock = net.connect(socketPath);
    const close = () => sock.destroy();
    sock.on("connect", () => {
      sock.write(
        JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } }) + "\n"
      );
    });
    sock.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) {
          if (!sock.ready) {
            reject(new SocketError(msg.error.message, msg.error.code));
          }
          return;
        }
        if (msg.result && !sock.ready) {
          sock.ready = true;
          resolve({ close });
          return;
        }
        if (msg.event) onEvent(msg);
      }
    });
    sock.on("error", (err) => {
      if (!sock.ready) reject(new SocketError(err.message, "connect_error"));
      else onEvent({ event: "stream.closed", data: {} });
    });
    sock.on("close", () => {
      if (!sock.ready) reject(new SocketError("closed before ack", "closed"));
      else onEvent({ event: "stream.closed", data: {} });
    });
  });
}

module.exports = { request, subscribe, defaultSocketPath, SocketError, expandHome };
