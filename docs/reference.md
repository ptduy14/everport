# Reference

Details for people who already use Everport. To get started, see the [README](../README.md).

## Commands

| Command                               | What it does                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `login`                               | Logs in to Cloudflare in your browser (runs `wrangler login`).                                 |
| `add <target> [-l, --label] [--copy]` | Adds a tunnel to a local service. The first one also creates the relay.                        |
| `up [--json]` / `down`                | Starts or stops the background agent and every enabled tunnel. `up` restores a lost preview.   |
| `ls` (`status`) `[--json] [--health]` | Lists tunnels. `--health` asks each public address who answers.                                |
| `start` / `stop <tunnel>`             | Turns one tunnel on or off. `<tunnel>` is its id or label.                                     |
| `rm` (`remove`) `<tunnel>`            | Removes the tunnel and its preview. The address stops working.                                 |
| `copy <tunnel>`                       | Copies the URL to the clipboard.                                                               |
| `doctor [--json]`                     | Checks Node, wrangler, login, the data folder and the relay, and says how to fix each failure. |

`<target>` is a port (`3000`), `host:port`, or a full URL. A bare port means `127.0.0.1`.

Results (URLs, tables, JSON) go to stdout. Progress and errors go to stderr, so `--json` and pipes stay clean. Exit code `0` is success, `1` an error or a failed tunnel, `2` wrong usage.

## Environment variables

| Variable               | Meaning                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `EVERPORT_DATA_DIR`    | Where Everport keeps its files.                                                |
| `EVERPORT_WORKER_NAME` | Name of the relay Worker (default `everport`); used when the relay is created. |
| `EVERPORT_DEBUG=1`     | Print stack traces for unexpected errors.                                      |

## Data folder

By default: `%LOCALAPPDATA%\everport` on Windows, `~/Library/Application Support/everport` on macOS, and `$XDG_DATA_HOME/everport` or `~/.local/share/everport` on Linux. Set `EVERPORT_DATA_DIR` to put it elsewhere.

It holds `tunnels.json` (your tunnels), `relay-secret` (the shared secret between the agent and the relay) and `logs/`.

## Cloudflare login and wrangler

Everport talks to Cloudflare through [wrangler](https://developers.cloudflare.com/workers/wrangler/). It runs one pinned version through `npx` (currently 4.166.0), so the first command that needs it downloads wrangler, which can take about a minute. It is cached afterwards.

`everport login` runs `wrangler login`, so the login happens in your browser and Wrangler keeps the credentials. Everport asks wrangler whether you are logged in; it does not read or store the login itself.

**API token instead of a browser login** (for CI): set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. If every call fails with Cloudflare error `9109` or `10000`, check that the token's start date is today or empty.

## Privacy and security

- **Usage data.** Everport's own code makes no analytics or telemetry calls. It talks to your local agent, your local service and your own relay on Cloudflare. Wrangler, which Everport runs, can send anonymous usage data to Cloudflare unless you opt out; see Cloudflare's [system environment variables](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) (`WRANGLER_SEND_METRICS`). Everport passes your environment to wrangler unchanged.
- **Relay secret.** `relay-secret` is written readable only by you (mode `0600`) on macOS and Linux. Windows has no such mode, so the file is protected only by your user folder's permissions.
- **Agent control API.** It listens on `127.0.0.1` only and every call needs a token that is generated each time the agent starts.
- **Public URLs.** Anyone who knows a URL can reach the service behind it.

## The first tunnel takes longer

The first `everport add` also creates the relay Worker in your Cloudflare account, so it takes longer than the ones after it. Everport says so while it works. In our measurements (one run each): about 17 to 24 seconds from Vietnam on Windows (about 10 seconds in a later manual try), about 70 seconds when wrangler first had to be downloaded, and 5 to 6 seconds on GitHub Actions runners, which are close to Cloudflare. Your time depends on your network. Later tunnels do not create the relay again, so they are quicker.

## Agent lifecycle

`everport up` starts one background agent, detached from your terminal and editor, and `everport down` stops it. Closing the terminal or VS Code does not stop it. Nothing starts the agent when your computer boots: run `everport up` again (or turn on `everport.startOnOpen` in VS Code). Tunnel addresses do not change in between.

## VS Code extension

| Setting                | Default | Meaning                                                                                                          |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `everport.startOnOpen` | off     | Start your enabled tunnels when VS Code opens. Off by default because starting makes your local services public. |
| `everport.nodePath`    | empty   | Path to a Node.js 22.12+ executable. Needed when VS Code starts without your shell's `PATH` (common on macOS).   |

Commands are under the **Everport** category in the Command Palette: Add Tunnel, Start All, Stop All, Start, Stop, Retry, Copy URL, Open in Browser, Check Health, Remove, Run Doctor, Show Log, Refresh and Log in to Cloudflare.

## Node.js and version managers

Everport needs Node.js **22.12 or newer**. The floor comes from the Cloudflare tool it runs (wrangler 4.166.0 declares `node >=22.12.0`), not from Everport's own code. The CLI always runs on the Node.js that started it. The VS Code extension picks one like this:

1. If `everport.nodePath` is set, it uses exactly that, and says why when it cannot run it.
2. Otherwise it uses `node` from the `PATH` that VS Code has. VS Code started from the Start menu, the Dock or a launcher does not have your shell's `PATH`, so with fnm, nvm or Volta it may find no Node.js, or an older one installed system-wide.
3. If that is missing or older than 22.12, it looks in the folders of fnm, nvm, Volta and asdf (and the usual system places such as Homebrew and `Program Files\nodejs`) and uses the newest version that wrangler runs on. The Everport output channel says which one it picked.

To choose yourself, run **Everport: Select Node.js** from the Command Palette (or press **Choose Node.js** in the Everport view): it lists the versions it found and lets you browse for a `node` executable. Or set `everport.nodePath` to the result of `node -p process.execPath` run in a terminal where the right Node.js is active.

Everport runs wrangler on the Node.js it picked, whatever the editor's own `PATH` says.

What we checked, on Linux and macOS (GitHub Actions runners) and on Windows: the paths below are what `process.execPath` printed, and the `node` and `wrangler` checks of `everport doctor` passed with each (the Windows row: with the fnm path in the first column).

| Manager | `process.execPath` looks like                                        | Checked on                   |
| ------- | -------------------------------------------------------------------- | ---------------------------- |
| fnm     | `~/.local/share/fnm/node-versions/vX.Y.Z/installation/bin/node`      | Linux, macOS                 |
| fnm     | `%APPDATA%\fnm\node-versions\vX.Y.Z\installation\node.exe`           | Windows                      |
| nvm     | `~/.nvm/versions/node/vX.Y.Z/bin/node`                               | Linux (not checked on macOS) |
| Volta   | `~/.volta/tools/image/node/X.Y.Z/bin/node` (not the `bin/node` shim) | Linux, macOS                 |

On Windows with fnm, `process.execPath` can show a `fnm_multishells\...` folder. That is a link (a junction) to the installed version, with the npm files next to it, but the `node-versions` path is the stable one. We did not check nvm-windows, asdf or other managers.

## Troubleshooting

Start with `everport doctor`: it checks each piece and prints a fix for every failure.

- **"You are not logged in to Cloudflare"**: run `everport login`, or set the API token variables.
- **The URL answers `503 tunnel offline`**: the agent is not running. Run `everport up`.
- **A tunnel shows `missing`**: its preview was lost on Cloudflare. `everport up` recreates it at the same address.
- **A tunnel shows a health of `mismatch`**: another Worker answers at that address. Remove the tunnel and add it again.
- **The first command takes a minute**: wrangler is downloaded once through `npx`, then cached.
- **VS Code says it needs Node.js 22.12, but your terminal has it**: VS Code did not inherit your shell's `PATH`. See [Node version managers](#node-version-managers).
- **An error says Wrangler requires at least Node.js v22.12.0**: the Node.js that runs wrangler is older than that. Switch to a newer Node.js, or set `everport.nodePath`.

## Cloudflare limits

Taken from Cloudflare's documentation on 22 November 2026. Check the current numbers.

- Workers Free plan: 100,000 requests per day ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
- Durable Objects on the Free plan: SQLite-backed only, 100,000 requests per day, with a 20:1 ratio for incoming WebSocket messages ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- Previews: 100 per Worker on the Free plan; past that Cloudflare deletes the least recently deployed one ([Previews](https://developers.cloudflare.com/workers/previews/)).
- Past a daily limit, operations of that type fail until 00:00 UTC.

We have not measured how much of this quota long sessions use.

## Known behaviour

- Cancelling a request halfway can take about 30 seconds to reach your local service.
- A tunnel's name becomes part of its hostname, so labels are lowercased, cleaned and shortened to fit.
- If something other than your relay answers at a tunnel's address, `up` refuses to touch it and tells you.
- Not supported yet: WebSockets of your own app (for example hot reload), streaming uploads, request flow control.
