#!/usr/bin/env bash
# Regenerates the README screenshots in docs/screenshots/ from the VHS tapes in docs/tapes/.
#
#   bash docs/screenshots.sh            # all tapes
#   bash docs/screenshots.sh agents     # only docs/tapes/agents.tape
#
# Needs herdr, jq, node, vhs (brew install vhs; pulls ttyd and ffmpeg), optionally pngquant/oxipng.
#
# Nothing touches your herdr: a separate herdr server runs with its own HOME in a throwaway sandbox (its own
# config, socket, sessions and plugin state) with demo workspaces, and is stopped afterwards. No real agent runs:
# agent panes are plain shell panes that print the canned output from docs/demo/ and report an agent state via
# `herdr pane report-agent`.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
herdr_bin=$(command -v herdr || echo "$HOME/.local/bin/herdr")
node_bin=$(command -v node)
cd "$repo"

# short path: herdr's unix sockets live under $HOME/.config/herdr
sandbox=$(cd "$(mktemp -d /tmp/ho.XXXXXX)" && pwd -P)
cleanup() {
	[ -x "$sandbox/env.sh" ] && "$sandbox/env.sh" herdr server stop >/dev/null 2>&1 || true
	rm -rf "$sandbox"
}
trap cleanup EXIT

home="$sandbox/h"
mkdir -p "$sandbox/bin" "$home"/{shop,api,homelab,docs}
ln -s "$herdr_bin" "$sandbox/bin/herdr"
ln -s "$node_bin" "$sandbox/bin/node"
cp docs/demo/*.txt "$home/"

# the environment of the sandboxed herdr (server, panes and plugin commands inherit it)
cat >"$sandbox/env.sh" <<EOF
#!/bin/sh
cd "$home"
exec env -i HOME="$home" PATH="$sandbox/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \\
	TERM=xterm-256color SHELL=/bin/zsh LANG=en_US.UTF-8 "\$@"
EOF
chmod +x "$sandbox/env.sh"
h() { "$sandbox/env.sh" herdr "$@"; }

mkdir -p "$home/.config/herdr"
cat >"$home/.config/herdr/config.toml" <<'EOF'
onboarding = false

[theme]
name = "dracula"

[update]
version_check = false
manifest_check = false

[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "herdr-overview.open"
description = "overview"
EOF
# a neutral prompt for the shell panes
printf "PROMPT='%%F{cyan}%%~%%f %%F{magenta}❯%%f '\n" >"$home/.zshrc"

pane_of() { jq -r '.result.root_pane.pane_id'; }
# print a canned output file (ANSI escapes as \033 text) in a pane
show() { h pane run "$1" "clear; printf '%b' \"\$(cat ~/$2.txt)\"; echo" >/dev/null; }
# same, but as an agent: no prompt afterwards, and the pane reports an agent state
agent() {
	# "done" is not reportable: herdr derives it when a working agent turns idle. It has to happen after
	# the tape attached (attaching marks finished agents as seen), so it runs delayed in the background.
	if [ "$3" = done ]; then
		h pane report-agent "$1" --source demo --agent claude --state working >/dev/null
		(sleep 6 && h pane report-agent "$1" --source demo --agent claude --state idle >/dev/null) &
	else
		h pane report-agent "$1" --source demo --agent claude --state "$3" >/dev/null
	fi
	# ends on an input line, so typed text (sync tape) shows up like an agent prompt
	h pane run "$1" "clear; printf '%b' \"\$(cat ~/$2.txt)\"; printf '\\n\\n\\033[1m>\\033[0m '; cat >/dev/null" >/dev/null
}

# demo workspaces: shop (server, agent, git log), api (server, agent waiting for approval),
# homelab (docker), docs (agent done)
seed() {
	local p t
	p=$(h workspace create --cwd "$home/docs" --label docs --no-focus | pane_of)
	h tab rename "${p%%:*}:t1" agent >/dev/null
	agent "$p" docs-agent done

	p=$(h workspace create --cwd "$home/homelab" --label homelab --no-focus | pane_of)
	h tab rename "${p%%:*}:t1" docker >/dev/null
	show "$p" homelab-docker

	p=$(h workspace create --cwd "$home/api" --label api --no-focus | pane_of)
	t=${p%%:*}
	h tab rename "$t:t1" agent >/dev/null
	agent "$p" api-agent blocked
	# the server tab is the active one, so the agent only shows up as a tile with the agents filter
	p=$(h tab create --workspace "$t" --cwd "$home/api" --label server --focus | pane_of)
	show "$p" api-server

	p=$(h workspace create --cwd "$home/shop" --label shop --focus | pane_of)
	t=${p%%:*}
	h tab rename "$t:t1" agent >/dev/null
	agent "$p" shop-agent working
	p=$(h pane split "$p" --direction right --cwd "$home/shop" --no-focus | jq -r '.result.pane.pane_id')
	show "$p" notes-shell
	p=$(h tab create --workspace "$t" --cwd "$home/shop" --label server --no-focus | pane_of)
	show "$p" shop-server
	sleep 1
}

start_herdr() {
	"$sandbox/env.sh" herdr server >>"$sandbox/server.log" 2>&1 &
	for _ in $(seq 50); do
		h status server 2>/dev/null | grep -q 'status: running' && break
		sleep 0.2
	done
	h plugin link "$repo" >/dev/null
	seed
}
stop_herdr() {
	h server stop >/dev/null 2>&1 || true
	rm -rf "$home/.config/herdr/session.json" "$home/.config/herdr/session-snapshots" "$home/.local/state"
	sleep 1
}

export HERDR_DEMO="$sandbox/env.sh"
tapes=("$@")
if [ ${#tapes[@]} -eq 0 ]; then
	for f in docs/tapes/*.tape; do
		[ "$(basename "$f")" = config.tape ] || tapes+=("$(basename "$f" .tape)")
	done
fi
for t in "${tapes[@]}"; do
	echo "== $t"
	start_herdr # a fresh herdr session per tape
	vhs "docs/tapes/$t.tape"
	stop_herdr
done
rm -rf .vhs

cd docs/screenshots
command -v pngquant >/dev/null && pngquant --force --skip-if-larger --quality 80-95 --ext .png ./*.png || true
command -v oxipng >/dev/null && oxipng -q -o 4 --strip safe ./*.png || true
ls -lh
