# Technical note: Herdr API investigation

All answers verified against Herdr 0.8.2 (protocol 20) against a live isolated
test session (`herdr --session ovtest server`) plus the bundled API schema
(`herdr api schema --json`) and the v0.8.2 plugin documentation. Nothing here
is guessed.

## 1. How does Herdr enumerate spaces?

`session.snapshot` returns `workspaces[]` (Herdr's term for spaces), each with
`workspace_id`, `number` (server order), `label`, `focused`, `active_tab_id`,
`pane_count`, `tab_count`, `agent_status`. The CLI equivalent is
`herdr workspace list`.

## 2. How does Herdr identify the active space?

`session.snapshot.focused_workspace_id`, and `workspace.focused == true` on
the workspace record. The `workspace.focused` event is also subscribable.

## 3. How does Herdr identify the active tab within a space?

`WorkspaceInfo.active_tab_id`. The tab layout snapshot for that tab
(see 4) gives its focused pane. `tab.focused` events exist as well.

## 4. How does Herdr identify the active pane?

Important nuance found by testing: `PaneInfo.focused` is **session-wide**
(only the foreground client's focused pane is `true`), not per-tab. The
authoritative per-tab focus is `focused_pane_id` on the tab layout snapshot
(`PaneLayoutSnapshot`, delivered in `session.snapshot.layouts` and by
`pane.layout` / `layout.updated` events). The plugin therefore mirrors
`layout.focused_pane_id` of each space's active tab.

## 5. Can a plugin subscribe to space/tab/pane focus changes?

Yes: `events.subscribe` accepts `workspace.focused`, `tab.focused`,
`pane.focused`, `layout.updated` and full lifecycle sets (`*.created`,
`*.closed`, `*.renamed`, `*.moved`, `*.exited`, `pane.updated`,
`pane.scroll_changed` per pane, ...). Subscriptions replay recent buffered
events on connect. The MVP polls `session.snapshot` each tick instead, which
covers all topology and focus changes within one tick (250 ms) with a single
request; subscriptions are a future optimisation.

## 6. Can terminal viewport cells be observed directly?

There is no streaming cell-change API. The closest primitive is
`pane.read` with `source: "visible"`, which returns the currently rendered
viewport. The server closes raw request connections shortly after the
response unless a subscription stream is open, so the plugin opens one
short-lived connection per read (a Unix-socket connect, no process spawn),
polls at `refresh_hz` (default 4), and hashes the result for change
detection.

## 7. Does the API preserve ANSI/style information?

Yes: `pane.read` accepts `format: "ansi"` and returns SGR sequences
(8/16/256-colour and `38;2`/`48;2` truecolour, bold, dim, italic, underline,
reverse). Verified with a live read of a styled viewport. Cursor-move
sequences, `ED`, and `EL` do not appear in `visible` reads; the parser
handles them defensively anyway.

## 8. Can multiple panes be observed concurrently?

Yes. Reads are independent requests; the plugin issues them sequentially per
tick, staggered per tile. One `session.snapshot` request per tick
provides the topology for all panes.

## 9. Is there an official plugin UI API for drawing arbitrary terminal cell grids?

No. Plugin v1 has no native UI: manifest `[[panes]]` entrypoints are argv
commands that run in a real terminal pane (placements: `overlay`, `popup`,
`split`, `tab`, `zoomed`). The overview is therefore a zero-dependency TUI
running in a `popup` placement, composing cell grids itself. This is the
documented fallback path and it still renders real viewport
content with ANSI styling. Follow-up finding from live use: proportional
decimation renders terminal text as gibberish (there is no font scaling in
a cell grid), so the default mirror strategy is a 1:1 bottom-anchored crop
of the live tail, with decimation kept behind `scale_mode = "fit"`.

## 10. Can a plugin focus a workspace/space/pane programmatically?

Yes: `workspace.focus {workspace_id}` focuses the space and its active tab
without touching pane layout or pane focus. (`tab.focus` also exists;
`pane.focus_direction` is relative-only.) The plugin focuses the workspace
when a tile is activated, then closes the popup.

## 11. How should plugin-owned panes be identified and excluded?

Popup panes have no pane ID, do not appear in `pane.*` APIs, emit no pane
lifecycle events, and do not receive `HERDR_PANE_ID` — with popup placement
there is nothing to exclude. For non-popup placements the plugin's own pane
is identified by its `HERDR_PANE_ID` environment variable and any tile whose
mirror target is that pane renders a `« this overview »` placeholder instead
of reading it.

## 12. What happens when a source pane resizes?

The next `pane.read --source visible` returns the new viewport dimensions;
the tile re-fits on the next tick (decimation is computed per frame).

## 13. What happens when a source pane exits?

`pane.read` fails with `pane_not_found` / the workspace closes with a final
`workspace.closed`. The tile shows `Pane closed` or disappears; other tiles
continue. Verified live by closing a tab mid-run.

## 14. Is the terminal observer read-only?

Yes. `pane.read` and `session.snapshot` mutate nothing. The only writes the
plugin performs are `workspace.focus` on tile activation and
`plugin.pane.open`/`popup.close` for its own UI.

## 15. Is there an official example plugin using the same APIs?

Community cookbook: `ogulcancelik/herdr-plugin-examples` (manifest shape,
actions, panes). No official first-party example exists; this plugin follows
the documented manifest contract directly.

## Additional protocol findings that shaped the design

- **Connection lifecycle**: the server closes a raw connection shortly after
  a request/response completes; sending further requests on the same
  connection fails with EPIPE. A connection holding an `events.subscribe`
  stream stays open but rejects additional requests. Hence: one-shot
  request connections (measured: 100 sequential connect+read round trips in
  ~4 s in Node, i.e. ~40 ms each — comfortably fast enough for 4 Hz × N
  tiles with staggering).
- **`PaneInfo.revision` never changes on output** in 0.8.2 (verified: stuck
  at 0 through output bursts), so it cannot drive change detection; the
  viewport text hash is used instead.
- **Viewport reads of TUI apps work**: `top`'s alternate screen content is
  returned as styled text with no cursor addressing.
- **Popup toggle**: `plugin.pane.open` with an already-open popup fails with
  `popup already open`; `popup.close` fails with `popup_not_open` when none
  is open. The toggle action maps the first error to close.
- **Headless caveat**: in a headless (`herdr server`) session the CLI
  sometimes reports `server_not_running` while the raw socket works; the
  plugin therefore talks raw socket first and only falls back to
  `HERDR_BIN_PATH`.
