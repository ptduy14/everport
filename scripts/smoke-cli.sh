#!/usr/bin/env bash
# Smoke test of the packed CLI on a real Cloudflare account (macOS, Linux, Git Bash on Windows).
#
# It packs `everport`, installs the tarball into an empty folder like a user would, and runs add, ls, down, up,
# stop, start and rm through the installed CLI. It creates a Worker called ep-smoke-<random> (or $EVERPORT_WORKER_NAME)
# and removes it again, whatever happens.
#
# Needs: Node 22+ on PATH, a Cloudflare login (wrangler login, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID),
# curl, and the port below free. Run from the repo root:   bash scripts/smoke-cli.sh
set -u
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
port="${SMOKE_PORT:-5577}"
worker="${EVERPORT_WORKER_NAME:-ep-smoke-$(node -e 'process.stdout.write(require("crypto").randomBytes(3).toString("hex"))')}"
body="hello from the cli smoke"
failures=0
origin_pid=""

say() { printf '[%4ss] %s\n' "$SECONDS" "$*"; }
expect() { if [ "$2" = "0" ]; then say "ok    $1"; else say "FAIL  $1"; failures=$((failures + 1)); fi; }
answers() { [ "$(curl -s -m 15 "$1")" = "$body" ]; }

cleanup() {
  say "cleaning up"
  [ -n "${E:-}" ] && "$E" down >/dev/null 2>&1
  [ -n "$origin_pid" ] && kill "$origin_pid" 2>/dev/null
  for _ in 1 2 3 4 5 6; do
    CI=1 npx -y wrangler@4.166.0 delete --name "$worker" --force >/dev/null 2>&1
    if CI=1 npx -y wrangler@4.166.0 versions list --name "$worker" --json 2>&1 | grep -q '10007'; then gone=0; break; else gone=1; sleep 2; fi
  done
  expect "the Worker $worker is gone from the account" "${gone:-1}"
  rm -rf "$work"
  say "done: $failures failure(s)"
  exit "$failures"
}
trap cleanup EXIT

cd "$repo" || exit 1
say "Worker for this run: $worker"
npm run build -w everport >/dev/null 2>&1
npm pack -w everport --pack-destination "$work" >/dev/null 2>&1
mkdir "$work/install" && cd "$work/install" && npm init -y >/dev/null 2>&1 && npm install "$work"/everport-*.tgz >/dev/null 2>&1
files="$(ls node_modules/everport/dist | tr '\n' ',')"
[ "$files" = "agent.js,everport.js,worker.js," ]; expect "the package holds the CLI, the agent and the Worker ($files)" $?

export EVERPORT_DATA_DIR="$work/data"
export EVERPORT_WORKER_NAME="$worker"
E="node $work/install/node_modules/everport/dist/everport.js"
ep() { say "\$ everport $*"; $E "$@" 2>&1 | sed 's/^/      /'; return "${PIPESTATUS[0]}"; }

node -e "require('http').createServer((q,r)=>r.end('$body')).listen($port,'127.0.0.1')" &
origin_pid=$!
sleep 1

ep --version >/dev/null; expect "version runs" $?
ep doctor; expect "doctor passes (a login is available)" $?

out="$($E add "$port" --label fe 2>&1)"; code=$?
say "\$ everport add $port --label fe   [exit $code]"; echo "$out" | sed 's/^/      /'
[ "$code" = "0" ]; expect "the first add works" $?
echo "$out" | grep -q 'workers.dev subdomain'; expect "the first add warns about the workers.dev subdomain" $?
url="$(echo "$out" | grep -E '^https://fe-.*\.workers\.dev$' | head -1)"
answers "$url"; expect "the address answers ($url)" $?

ep ls --health | grep -qE 'active +ok'; expect "health is ok" $?
$E add "$port" --label fe >/dev/null 2>&1; [ "$?" = "1" ]; expect "a duplicate label is refused with exit code 1" $?

ep down >/dev/null
[ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$url")" = "503" ]; expect "down stops the tunnel (503)" $?
ep up >/dev/null
answers "$url"; expect "up brings it back at the same address" $?
ep stop fe | grep -q stopped; expect "stop says stopped" $?
ep start fe | grep -q active; expect "start says active" $?
answers "$url"; expect "the address answers after start" $?
ep rm fe >/dev/null; expect "rm removes the tunnel" $?
ep ls | grep -q 'No tunnels yet'; expect "ls is empty again" $?
ep down >/dev/null
