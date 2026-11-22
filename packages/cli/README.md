# Everport

**Stable public URLs for the services on your machine, served from your own Cloudflare account.**

[![ci](https://github.com/ptduy14/everport/actions/workflows/ci.yml/badge.svg)](https://github.com/ptduy14/everport/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/ptduy14/everport/blob/main/LICENSE)

Register a URL once with Stripe, GitHub, Google or an AI connector, and never paste a new one again. Everport gives each local port its own address that **never changes**, even after you restart your computer. There is no Everport server: the relay is a small Worker that runs in **your** Cloudflare account, and nothing sits in front of your content (no warning page).

> **Status: pre-release (0.1).** The whole flow has been run against a real Cloudflare account on Windows, macOS (Apple silicon) and Linux. **It has not been tried inside ChatGPT's sandboxed iframe yet**, and the browser login (`everport login`) has not been exercised in an automated run. Details in [Where it has been tested](#where-it-has-been-tested). Everport is unofficial and not affiliated with Cloudflare.

## Why Everport

Webhook senders, OAuth providers and AI connectors store the URL you give them. If your tunnel URL changes on every run, you have to update every one of those places by hand. Existing options each fail in some way for this job:

- a tunnel with a random URL changes every time;
- free plans of hosted tunnels often give you **one** stable address, or put a browser warning page in front of your content, which breaks anything a browser loads from another site (an iframe, a script);
- editor port forwarding stops when the editor closes.

Everport gives you several fixed addresses at once, free, without a domain, managed from the command line or VS Code, and they keep running after you close VS Code.

## What you get

- **A fixed URL per local service**, like `https://api-everport.<you>.workers.dev`. Several at once.
- **No warning page** in front of your content. A browser loads scripts and iframes from it as from any site.
- **Runs after you close the terminal or VS Code**: a small background agent keeps the tunnels up.
- **Fast restarts**: `everport down` then `everport up` brings every tunnel back at the same address within a few seconds (about a second in our runs).
- **Self-healing**: if a preview on Cloudflare is lost, `everport up` recreates it at the same address.
- **Your account, your quota, your data**: no shared service, nothing to sign up for besides Cloudflare.
- **A CLI and a VS Code extension** with the same actions (add, start, stop, health check, doctor).

## Quick start

You need a Cloudflare account and Node.js 22 or newer.

```bash
npm install -g everport
everport login            # opens your browser; Cloudflare's own tool handles the login
everport add 3000         # first run creates the relay (about 20 s); prints the public URL
```

Open the printed address: it serves what is on `http://127.0.0.1:3000`. From now on `everport down` and `everport up` stop and start everything, and the URL stays the same.

<!-- TODO(media): add a terminal recording of the quick start and a screenshot or GIF of the VS Code view here -->

## How it works

```
caller (webhook, browser, AI connector)
   │  https://<name>-<worker>.<you>.workers.dev
   ▼
Worker + Durable Object in YOUR Cloudflare account   (one preview per tunnel)
   ▲  WebSocket opened from your computer (outbound only, no open ports)
   │
Everport agent (a background Node process on your machine)
   │  HTTP to 127.0.0.1
   ▼
your local service (3000, 3301, 5500, ...)
```

<!-- TODO(diagram): replace the text diagram above with a drawn diagram of the request path -->

- `everport add` creates a small relay **Worker** in your account the first time, then one **preview** per tunnel. A preview is a named copy of the Worker with its own address and its own Durable Object.
- The **agent** on your machine opens one outbound WebSocket per tunnel. Public requests arrive at the Durable Object, travel down that socket, are replayed against your local port, and the response streams back.
- Your computer only calls **out**. No port is opened, no firewall rule is needed.
- The agent is separate from your terminal and editor, so tunnels survive closing them.

More detail: [docs/ARCHITECTURE.md](https://github.com/ptduy14/everport/blob/main/docs/ARCHITECTURE.md).

## Install

```powershell
npm install -g everport
```

Needs Node.js 22 or newer. The package has no runtime dependencies: it holds the CLI (`everport`, alias `ep`), the background agent and the relay Worker. A VS Code extension with the same actions is published separately as "Everport" (publisher `everport-dev`).

## Use

```bash
everport login                 # opens your browser; Everport never sees your credentials
everport add 3000              # a port, host:port, or a full URL; prints the public URL
everport add 5500 --label widgets
everport ls --health           # every tunnel, its state, and what answers at its public address
everport down                  # stop the agent; addresses are kept
everport up                    # start again, same addresses
everport rm widgets            # delete the tunnel and its preview from Cloudflare
```

| Command                               | What it does                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `login`                               | Logs in to Cloudflare in your browser (`wrangler login`).                                                       |
| `add <target> [-l, --label] [--copy]` | Adds a tunnel to a local service. The first one also creates the relay.                                         |
| `up [--json]` / `down`                | Starts or stops the background agent and every enabled tunnel. `up` brings back a preview that Cloudflare lost. |
| `ls` (`status`) `[--json] [--health]` | Lists tunnels. `--health` asks each public address who answers.                                                 |
| `start` / `stop <tunnel>`             | Turns one tunnel on or off. `<tunnel>` is its id or label.                                                      |
| `rm` (`remove`) `<tunnel>`            | Removes the tunnel and its preview. The address stops working.                                                  |
| `copy <tunnel>`                       | Copies the URL to the clipboard.                                                                                |
| `doctor [--json]`                     | Checks Node, wrangler, login, the data folder and the relay; every failure says how to fix it.                  |

Data (URLs, tables, JSON) goes to stdout, progress and errors to stderr, so `--json` and pipes stay clean. Exit code `0` is success, `1` an error or a failed tunnel, `2` wrong usage.

**Settings through the environment:**

| Variable               | Meaning                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `EVERPORT_DATA_DIR`    | Where Everport keeps its files (see below).                                                |
| `EVERPORT_WORKER_NAME` | Name of the relay Worker (default `everport`); only used when the first tunnel is created. |
| `EVERPORT_DEBUG=1`     | Print stack traces for unexpected errors.                                                  |

**Where files live:** `%LOCALAPPDATA%\everport` on Windows, `~/Library/Application Support/everport` on macOS, `$XDG_DATA_HOME/everport` or `~/.local/share/everport` on Linux. It holds `tunnels.json`, `relay-secret` and `logs/`.

**With an API token instead of a browser login** (for CI): set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. A user token with Workers permissions worked in our runs on GitHub Actions. Its **start date must be today or empty**: a start date in the future makes every call fail (Cloudflare error `9109` or `10000`) even though the token looks active.

## VS Code extension

Open the Everport view in the Activity Bar. It offers the same actions: log in to Cloudflare, add a tunnel (with a picker of the ports that are listening), start and stop one or all, copy and open URLs, check health, run the doctor, show the log. The status bar shows how many tunnels are running.

| Setting                | Default | Meaning                                                                                                          |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `everport.startOnOpen` | off     | Start your enabled tunnels when VS Code opens. Off by default because starting makes your local services public. |
| `everport.nodePath`    | empty   | Path to a Node.js 22+ executable. Needed when VS Code starts without your shell's `PATH` (common on macOS).      |

## Things to know

**What you depend on.** The relay runs on Cloudflare's free Workers platform, in your account. Everport is built on **Workers Previews, which are in open beta**: Cloudflare can change or stop them, and Everport does not control that. Everport will not silently switch to another strategy, because that would change your URLs without telling you. If Previews change, the plan is an explicit, announced move to one Worker per tunnel, aimed at keeping the same hostnames. That move is **a plan, not implemented code**: see [docs/contingency.md](https://github.com/ptduy14/everport/blob/main/docs/contingency.md).

**Free plan limits.** According to Cloudflare's documentation when this was written (check the current numbers): 100,000 requests per day for Workers and for Durable Objects, and at most 100 previews per Worker. Past a limit, requests fail until 00:00 UTC; you are not billed on the free plan. People who guess a URL spend your quota, nobody else's. We have **not** measured quota use over many hours.

**Your URLs are public.** Anyone who knows a URL can reach the service behind it. Do not expose a service that has no authentication. The address also contains your Cloudflare `workers.dev` subdomain, which Cloudflare may have taken from your email address when you created the account; Everport warns you after your first tunnel.

**Where your secrets are.** Everport creates a random relay secret in the data folder (`relay-secret`), readable only by you on macOS and Linux. **On Windows there is no chmod, so the file is protected only by your user folder's permissions**, which is weaker. Everport never reads or stores wrangler's login. The agent's control API listens on `127.0.0.1` only and needs a per-run token. No telemetry is sent.

**Known behaviour.**

- Cancelling a request halfway takes about 30 seconds to reach your local service (measured on Cloudflare). Other requests keep working meanwhile.
- A tunnel's name becomes part of its hostname, so labels are lowercased, cleaned and shortened to fit.
- Removing a tunnel and adding the same label again gave the same address in our test, but that is not guaranteed.
- If something other than your relay answers at a tunnel's address, `up` refuses to touch it and tells you.
- Not supported yet: WebSockets of your own app (for example hot reload), streaming uploads, request flow control.

**Terms and guarantees.** You are responsible for following Cloudflare's terms. Free and stable both depend on Cloudflare. Everport is a development tool, not for production, and comes with no warranty (MIT license).

## Compared with other options

As of November 2026, from our own tests and the vendors' documentation; products change.

| Option                  | Fixed URL, free         | In our experience                                                              |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| **Everport**            | Yes, several, no domain | Needs a Cloudflare account and Node.js; Previews are in beta                   |
| ngrok (free plan)       | One static domain       | A browser warning page can appear in front of content                          |
| Cloudflare Quick Tunnel | No, a new URL every run | In our test, server-sent events arrived all at once at the end                 |
| zrok.io (free plan)     | Yes                     | A warning page for browsers broke scripts and iframes loaded from another site |
| VS Code port forwarding | No in practice          | Stops when VS Code closes                                                      |

## Troubleshooting

Start with `everport doctor`: it checks each piece and prints a fix for every failure.

- **"You are not logged in to Cloudflare"**: run `everport login` (or set the API token variables).
- **The URL answers `503 tunnel offline`**: the agent is not running. Run `everport up`.
- **A tunnel shows `missing`**: its preview was lost on Cloudflare. `everport up` recreates it at the same address.
- **A tunnel shows a health of `mismatch`**: another Worker answers at that address. Remove the tunnel and add it again.
- **The first command takes a minute**: wrangler is being downloaded through `npx`; it is cached afterwards.
- **VS Code says it needs Node.js 22**: install it, or set `everport.nodePath` to the executable.
- **Every call fails with `9109` or `10000` using an API token**: check the token's start date.

## Where it has been tested

| What                                                                                                                    | Result                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Unit tests (about 530)                                                                                                  | Pass on Linux and Windows on every push; also run on macOS                                                     |
| The whole flow against a real Cloudflare account (add, serve, stop, start, restart, killed agent, lost preview, remove) | Run on Windows, and on macOS (Apple silicon) and Ubuntu through GitHub Actions with an API token; one run each |
| The VS Code extension in a real VS Code, including tunnels that keep answering after VS Code exits                      | Run on the same three systems                                                                                  |
| `everport login` in the browser                                                                                         | Used by hand on Windows only; not part of any automated run                                                    |
| Hand test of the extension's screens (picker, dialogs)                                                                  | Not done yet                                                                                                   |
| **Inside ChatGPT's sandboxed iframe**                                                                                   | **Not tested**                                                                                                 |
| Several hours of use, quota consumption, the 100-preview limit                                                          | Not measured                                                                                                   |

## Roadmap

Nothing here is promised. Ideas: update the relay code after a new release, rotate the relay secret, detect orphaned tunnels, the move to one Worker per tunnel if Previews change, WebSockets of the app itself.

## Contributing

Bug reports and pull requests are welcome: see [CONTRIBUTING.md](https://github.com/ptduy14/everport/blob/main/CONTRIBUTING.md). For a security problem, see [SECURITY.md](https://github.com/ptduy14/everport/blob/main/SECURITY.md) and do not open a public issue. Never paste tokens or the contents of `relay-secret`.

## License

[MIT](https://github.com/ptduy14/everport/blob/main/LICENSE). Everport is not affiliated with, endorsed by or sponsored by Cloudflare. Cloudflare, Workers and Durable Objects are trademarks of Cloudflare, Inc.
