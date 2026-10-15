# Sync typing: the agents filter, then "I" types into every agent at once.
Output ".vhs/sync.gif"
Source "docs/tapes/config.tape"

Hide
Type '"$HERDR_DEMO" herdr' Enter
Sleep 4s
Ctrl+B
Type "o"
Sleep 2s
Type "a"
Sleep 2s
Type "I"
Sleep 500ms
Type "rebase on main and run the tests"
Sleep 2s
Show
Sleep 300ms
Screenshot "docs/screenshots/sync.png"
