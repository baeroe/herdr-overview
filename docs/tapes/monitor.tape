# The monitor window: the overview running on its own in a terminal with a small font (what the
# herdr-overview.monitor action opens in Ghostty), so the tiles show (almost) whole panes.
Output ".vhs/monitor.gif"
Source "docs/tapes/config.tape"
Set FontSize 9

Hide
Type 'D=$(dirname "$HERDR_DEMO"); "$HERDR_DEMO" env HERDR_OVERVIEW_MONITOR=1 HERDR_PLUGIN_STATE_DIR="$D/monitor-state" node "$PWD/bin/overview.js"' Enter
Sleep 4s
Show
Sleep 300ms
Screenshot "docs/screenshots/monitor.png"
