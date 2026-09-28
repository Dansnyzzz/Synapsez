#!/usr/bin/env bash
# Synapsez — add this computer.
#
# Run the line the app gave you. Everything variable arrives in the environment
# and this file is byte-for-byte the same for every deployment and every user —
# deliberately, because the caller pipes it straight into a shell, and anything
# a server joined into the text would become code.
#
#   AIR_TOKEN='...' AIR_SERVER='https://your-app' AIR_REPO='https://...' \
#     bash -c "$(curl -fsSL https://your-app/setup.sh)"
#
# Nothing here needs root, and nothing here should be given any.

set -euo pipefail

say() { printf '  %s\n' "$1"; }
fail() { printf '\n  \033[31m%s\033[0m\n\n' "$1" >&2; exit 1; }

printf '\n  \033[32mSynapsez\033[0m\n\n'

[ -n "${AIR_TOKEN:-}" ]  || fail "No setup token. Copy the whole line from the app."
[ -n "${AIR_SERVER:-}" ] || fail "No server address. Copy the whole line from the app."
[ -n "${AIR_REPO:-}" ]   || fail "No source address. Copy the whole line from the app."

server="${AIR_SERVER%/}"
case "$server" in
  http://*|https://*) ;;
  *) fail "That server address does not look right: $server" ;;
esac

command -v curl >/dev/null || fail "curl is not installed."
command -v git  >/dev/null || fail "git is not installed."
command -v node >/dev/null || fail "Node.js is not installed. Get version 20 or newer from nodejs.org."

major="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$major" -ge 20 ] || fail "This needs Node 20 or newer. You have $(node -v)."

# ── who is this computer about to answer to? ──────────────────────────
#
# Asked before anything is installed, and answered out loud. A setup token
# travels toward a machine, so somebody can be handed one and told it does
# something else — and the only defence is telling the person at the keyboard
# whose account is about to get the files, the shell and the screen of this
# computer.

preview="$(curl -fsSL -X POST "$server/api/pair/enrol" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$AIR_TOKEN\"}")" \
  || fail "That setup link is not valid any more. Get a new one from the app."

# Read one string field out of a JSON object, defensively.
#
# This was `sed -n 's/.*"key":"\([^"]*\)".*/\1/p'`, which is wrong in two ways
# that matter here. `.*` is greedy, so with more than one occurrence of the key
# it returns the *last* — and the value it extracts is whatever the surrounding
# response happens to contain. And `[^"]*` accepts backslashes, so an escaped
# quote inside a value walks straight through it.
#
# For `token` that is a corrupt token and a confusing failure. For `account` it
# is worse: that value is the whole of the confirmation prompt below, the one
# control standing between a person and handing their machine to somebody
# else's account. A field an attacker can influence must not be able to write
# what that prompt says.
#
# `grep -o` returns every match rather than the last, `head -n1` takes the
# first, and `[^"\\]*` refuses any value containing a backslash rather than
# trying to decode escapes in shell.
json_string() {
  printf '%s' "$2" \
    | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"\\\\]*\"" \
    | head -n 1 \
    | sed 's/^[^:]*:[[:space:]]*"//; s/"$//'
}

account="$(json_string account "$preview")"
[ -n "$account" ] || fail "That setup link is not valid any more. Get a new one from the app."

# Shown to a person as the basis of a yes/no decision, so it must not be able to
# repaint the terminal around itself — an escape sequence here could erase the
# warning it sits inside.
#
# Control characters only. An earlier version of this rejected everything
# outside printable ASCII, which would have refused a perfectly ordinary
# non-ASCII email address — and this app's users are largely not anglophone.
case "$account" in
  *[[:cntrl:]]*) fail "The server sent an account name this script will not display. Get a new link from the app." ;;
esac

printf '\n  \033[33mThis will give  %s  full access to this computer:\033[0m\n' "$account"
printf '  \033[33mits files, a shell, and control of your screen.\033[0m\n\n'
printf '  Continue only if that is your own account.\n\n'

# `bash -c "$(curl ...)"` leaves stdin free, but a plain pipe into bash does not
# — read from the terminal directly so the prompt works either way.
if [ -r /dev/tty ]; then
  printf '  Type YES to continue: '
  read -r answer < /dev/tty
else
  fail "No terminal to ask on. Run the command the app gave you rather than piping this into a shell."
fi
[ "$answer" = "YES" ] || fail "Stopped. Nothing was installed and nothing was given away."

# ── where it lives ────────────────────────────────────────────────────

root="${AIR_HOME:-$HOME/.local/share/ai-remote}"

if [ -d "$root/.git" ]; then
  say "Updating the copy already in $root"
  git -C "$root" pull --ff-only >/dev/null 2>&1 || true
else
  say "Downloading into $root"
  mkdir -p "$(dirname "$root")"
  git clone --depth 1 "$AIR_REPO" "$root" >/dev/null 2>&1 \
    || fail "Could not download the source from $AIR_REPO"
fi

say "Installing dependencies (this takes a minute)"
(cd "$root" && npm install --no-audit --no-fund >/dev/null 2>&1) \
  || fail "npm install failed. Run it by hand in $root to see why."

# ── redeem the token ──────────────────────────────────────────────────

host="$(hostname 2>/dev/null || echo 'A computer')"
platform="$(uname -s) $(uname -m)"

paired="$(curl -fsSL -X POST "$server/api/pair/enrol" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$AIR_TOKEN\",\"confirm\":true,\"name\":\"$host\",\"info\":{\"platform\":\"$platform\",\"hostname\":\"$host\"}}")" \
  || fail "Could not finish setup."

device_token="$(json_string token "$paired")"
[ -n "$device_token" ] || fail "Could not finish setup: the server did not return a token."

umask 077
cat > "$root/worker/.env" <<ENVFILE
# Written by setup. Delete WORKER_TOKEN to pair this computer again.
SERVER_URL=$server
WORKER_TOKEN=$device_token
ENVFILE

# A live credential for this computer. Nobody needs it in their scrollback.
unset AIR_TOKEN device_token

say "Paired as \"$host\"."

# ── start it, and keep starting it ────────────────────────────────────

(cd "$root" && node scripts/autostart.js --install) || true

printf '\n  \033[32mDone. This computer is now yours from any device you sign in on.\033[0m\n'
printf '  %s\n\n' "$server"
printf '  To stop it running at login:  node "%s/scripts/autostart.js" --uninstall\n\n' "$root"
