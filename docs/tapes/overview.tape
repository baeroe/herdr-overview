# The overview of all spaces (ctrl+b o in the demo config, alt+o in the README).
Output ".vhs/overview.gif"
Source "docs/tapes/config.tape"

Hide
Type '"$HERDR_DEMO" herdr' Enter
Sleep 4s
Ctrl+B
Type "o"
Sleep 3s
Show
Sleep 300ms
Screenshot "docs/screenshots/overview.png"
