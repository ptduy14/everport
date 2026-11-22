# Everport

Give each local service a public URL that never changes. The URL lives on a small relay in **your own Cloudflare account**: there is no Everport server, no domain to buy, and no browser warning page in front of your service.

Built for developers who register local services with outside platforms: webhooks, OAuth callbacks, AI connectors. Register the URL once, never paste it again.

> **Status: pre-release.** Tested on Windows against a real Cloudflare account. **Not yet tested on macOS or Linux, and not yet tested inside ChatGPT's sandboxed iframe.** Not published on npm or the VS Code Marketplace yet. Everport is unofficial and not affiliated with Cloudflare.

## How it works

```
caller (webhook, browser, ChatGPT)
   │  https://api-everport.<you>.workers.dev
   ▼
Cloudflare Worker "everport" in your account   (one preview per tunnel, each with its own Durable Object)
   ▲  WebSocket opened from your computer (outbound only, no open ports)
   │
Everport agent (background Node process)  ──►  http://127.0.0.1:3000
```

- `everport add 3000` creates the relay Worker on the first run, then one **preview** per tunnel. Each preview has a stable address.
- A small background **agent** on your computer holds one outbound WebSocket per tunnel and forwards requests to your local port. It keeps running after you close the terminal or VS Code.
- `everport down` stops the agent; the addresses stay. `everport up` brings everything back at the same addresses, and recreates a preview that Cloudflare has lost.

## Requirements

- A Cloudflare account (the free plan is the target; see the limits below).
- Node.js 22 or newer.
- Network access on the first run: Everport pins one version of Cloudflare's `wrangler` tool and downloads it through `npx`. A cold first run can take more than a minute (about 70 s for the first tunnel in our measurements).

## Install

Everport is not on npm yet. Build the package from this repository:

```powershell
npm install
npm run build -w everport
npm pack -w everport
npm install -g ./everport-0.0.0.tgz
```

The packed tarball was tested by installing it into a clean folder; a global install of it has not been tested. The package contains three files and no runtime dependencies: the CLI (`everport`, alias `ep`), the background agent, and the relay Worker.

### VS Code

```powershell
npm run package -w everport-vscode
code --install-extension packages/vscode/everport-vscode-0.0.0.vsix
```

Open the Everport view in the Activity Bar. It offers the same actions: log in, add a tunnel (with a picker of running ports), start and stop, copy and open URLs, health check, doctor, log. If VS Code cannot find Node 22+, set `everport.nodePath`.

## Use

```powershell
everport login          # opens your browser; Cloudflare's own tool handles the login
everport add 3000       # first run creates the relay (~20 s with a warm cache); prints the URL
everport add 5500 --label widgets
everport ls --health    # state of every tunnel, and what answers at each public address
everport down           # stop the agent; addresses are kept
everport up             # start again, same addresses
everport rm widgets     # delete the tunnel and its preview from Cloudflare
```

| Command                               | What it does                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                               | Logs in to Cloudflare in your browser (`wrangler login`). Everport never sees your credentials.                                                                                                           |
| `add <target> [-l, --label] [--copy]` | Adds a tunnel to a local service: a port, `host:port`, or a full URL.                                                                                                                                     |
| `up` / `down`                         | Starts or stops the background agent and every enabled tunnel.                                                                                                                                            |
| `ls` (`status`) `[--json] [--health]` | Lists tunnels. `--health` asks each public address who answers.                                                                                                                                           |
| `start` / `stop <tunnel>`             | Turns one tunnel on or off. `<tunnel>` is an id or a label.                                                                                                                                               |
| `rm` (`remove`) `<tunnel>`            | Removes a tunnel and its preview. The address stops working. Adding a tunnel with the same label later gave the same address in our one test (the name comes from the label), but that is not guaranteed. |
| `copy <tunnel>`                       | Copies the URL to the clipboard.                                                                                                                                                                          |
| `doctor [--json]`                     | Checks Node, wrangler, login, data folder and relay; each failure says how to fix it.                                                                                                                     |

Data goes to stdout and progress and errors to stderr, so `--json` and pipes stay clean. Exit code 0 is success, 1 is an error or a failed tunnel, 2 is wrong usage.

Environment variables: `EVERPORT_DATA_DIR` (data folder), `EVERPORT_WORKER_NAME` (name of the relay Worker, only used when the first tunnel is created), `EVERPORT_DEBUG=1` (print stack traces).

## What you need to know

**What you depend on.** The relay runs on Cloudflare's free Workers platform, in your account. Everport is built on **Workers Previews, which are in open beta**. Cloudflare can change or stop them, and Everport does not control that. Everport will not silently switch strategy, because that would change your URLs without telling you. If Previews change, the plan is an explicit, announced migration to one Worker per tunnel, aimed at keeping the same hostnames. That migration is **a plan, not implemented code**: see [docs/contingency.md](docs/contingency.md).

**Limits of the free plan.** According to Cloudflare's documentation when this was written (check the current numbers): 100,000 requests per day for Workers and for Durable Objects, at most 100 previews per Worker. Past the limit requests fail until 00:00 UTC; you are not billed on the free plan. Strangers who guess a URL spend your quota, not anyone else's.

**Your URLs are public.** Anyone who knows a URL can reach the service behind it. Do not expose a service that has no authentication. The address also contains your Cloudflare `workers.dev` subdomain, which Cloudflare may have taken from your email address; Everport warns you after your first tunnel.

**Where your secrets are.** Everport creates a random relay secret, stored in the data folder (`relay-secret`) with owner-only permissions on macOS and Linux. **On Windows there is no chmod: the file is protected only by your user folder's permissions**, which is weaker. Everport never reads or stores wrangler's login. The agent's control API listens on `127.0.0.1` only. No telemetry is sent.

Data folder: `%LOCALAPPDATA%\everport` on Windows, `~/Library/Application Support/everport` on macOS, `~/.local/share/everport` on Linux (or `$XDG_DATA_HOME/everport`). It holds `tunnels.json`, `relay-secret`, and `logs/`.

**Known behaviour.**

- Cancelling a request mid-stream takes about 30 s to reach your local service (measured on Cloudflare).
- Each tunnel name becomes part of a hostname, so it is lowercased, cleaned and shortened to fit; a suffix is added if it is taken.
- If something else answers at a tunnel's address (not your relay), `up` refuses to touch it and says so.

**Terms and guarantees.** You are responsible for following Cloudflare's terms. Free and stable depend on Cloudflare. Everport is a tool for development, not for production, and comes with no warranty (MIT license).

## Develop

```powershell
npm install
npm test              # fast tests, no network
npm run typecheck
npm run lint
npm run test:e2e      # opt-in: needs the network and a Cloudflare account
```

Smoke scripts that run the packed CLI against a real Cloudflare account (they create and remove a Worker named `ep-smoke-*`): `scripts/smoke-cli.ps1` and `scripts/smoke-measure.ps1` (Windows).

Packages: `core` (the `Everport` class and its ports), `relay` (protocol and the Worker), `agent` (background process), `cli`, `vscode`.

## Report a problem

Use the issue templates. For a security problem, see [SECURITY.md](SECURITY.md). Never paste tokens or the contents of `relay-secret`.

## License

MIT
