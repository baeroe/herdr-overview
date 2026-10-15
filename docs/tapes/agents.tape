# The agents filter: open the overview, press "a", move down a row and press "f" to mark that agent as a favorite.
Output ".vhs/agents.gif"
Source "docs/tapes/config.tape"

Hide
Type '"$HERDR_DEMO" herdr' Enter
Sleep 4s
Ctrl+B
Type "o"
Sleep 2s
Type "a"
Sleep 2s
Down
Type "f"
Sleep 2s
Show
Sleep 300ms
Screenshot "docs/screenshots/agents.png"
