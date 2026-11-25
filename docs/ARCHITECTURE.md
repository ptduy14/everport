# Architecture

How Everport works, for people who want to understand it, review it or change it. For using it, see the [README](../README.md).

## The idea in one paragraph

A tunnel needs two ends that can reach each other. Your computer can make outgoing connections but cannot be reached from the internet; Cloudflare can be reached but cannot reach your computer. So the agent on your computer opens an outgoing WebSocket to a Worker in **your own** Cloudflare account, and that Worker sends public requests down the socket. The Worker is the public address; the agent is the only thing that ever talks to your local service.

## The request path

```
caller (webhook, browser, AI connector)
   │  HTTPS
   ▼
https://<name>-<worker>.<you>.workers.dev        one preview of the relay Worker per tunnel
   │
Worker (one bundle of relay code)
   │  stub.fetch
   ▼
Durable Object (one per preview)
   ▲  WebSocket, opened by the agent (outbound from your machine)
   │
Agent (a background Node process)
   │  HTTP to 127.0.0.1
   ▼
local service
```

<!-- TODO(diagram): replace with a drawn sequence diagram (request down, response streamed back) -->

- **No Everport server.** Everything runs in your account. Nothing is shared between users.
- **One tunnel = one preview = one hostname = one Durable Object.** A _preview_ is a named copy of a Worker with its own `workers.dev` hostname, variables, secrets and Durable Object namespace (a Cloudflare feature that its `wrangler preview` command labels open beta).
- The computer only calls out: no port is opened.

## Packages

| Package           | Role                                                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/relay`  | The wire protocol (frame codec, token check, header filters), the shared `RelayCore`, the Worker and Durable Object (`src/worker`), a fake relay for tests (`@everport/relay/testing`), and the generator of `wrangler.toml` |
| `packages/core`   | The `Everport` class (the API the CLI and VS Code call), `RelayDeployer` (talks to Cloudflare through wrangler), the config store, the port scanner, and the fakes and adapters                                              |
| `packages/agent`  | The background process: `TunnelConnection`, `RelayAgent`, its control API, the launcher, and `createEverport`, which wires everything to the real world                                                                      |
| `packages/cli`    | The `everport` command; also the published npm package, three self-contained files                                                                                                                                           |
| `packages/vscode` | The VS Code extension                                                                                                                                                                                                        |

The core follows **ports and adapters**: it never calls `child_process`, `fetch` or the file system directly. Each goes through a small interface, replaced by a fake in unit tests, so most logic is tested without Cloudflare, wrangler or a network. The core reaches the agent through an `AgentControl` interface, so it does not depend on the agent package.

## What each command does

- **`add`**: checks the input and the login, creates a secret if needed, creates the preview (the first one also creates the Worker, alone), reads the real slug and URL from wrangler's JSON, checks that the address is answered by _this_ relay and that the agent handshake works, saves the configuration, and hands the tunnel to the agent. If saving fails the new preview is removed; if only the agent fails the tunnel is kept and reported `failed`.
- **`up`**: asks each preview who answers at its address. A missing preview is recreated under the same name (same URL). An address answered by a foreign Worker, or an unreachable network, is **never** recreated. One tunnel failing does not stop the others.
- **`down`**: stops the agent. Previews stay on Cloudflare, so the addresses stay.
- **`remove`**: deletes the preview on Cloudflare first (the step that can fail), then updates the agent and the configuration. With `--local` (in VS Code, **Remove from List Only**, offered when the Cloudflare step fails) it skips Cloudflare, for when it cannot be reached; the preview may then remain.
- **`doctor`**: checks Node, the pinned wrangler, the login, the data folder, the configuration, the relay and the agent, and prints a fix for each failure.

## The relay protocol

**Agent connection.** The agent calls `GET https://<host>/__connect?token=<hex>` with `Upgrade: websocket`. The token is `HMAC-SHA256(secret, "connect:" + tunnelName)` in lowercase hex, compared in constant time. Replies: `101` accepted, `403` bad token, `426` not a WebSocket request, `500` relay has no secret. One agent per tunnel: a new connection closes the old one with code `1000` and reason `replaced`. A WebSocket upgrade on any other path is refused with `501`, by the Worker and again by the Durable Object, so only a request that passed the token check can become the agent (and the local service's own WebSockets are not relayed).

**Identity.** `GET /__ep/version` returns `{ "name": "everport-relay", "codeVersion": "...", "tunnel": "<name>" }`. Everport uses it to check that the thing answering at an address is its own relay.

**Frames.** Binary WebSocket messages: `[type u8][streamId u32 big-endian][payload]`, with one stream per public request.

| type | name     | payload                                            |
| ---- | -------- | -------------------------------------------------- |
| 1    | REQ_HEAD | JSON: method, path with query, headers, `hasBody`  |
| 2    | REQ_DATA | a chunk of the request body (up to 64 KiB)         |
| 3    | REQ_END  | empty; always sent                                 |
| 4    | RES_HEAD | JSON: status, headers                              |
| 5    | RES_DATA | a chunk of the response body (up to 64 KiB)        |
| 6    | RES_END  | empty                                              |
| 7    | RESET    | empty; cancels the stream, either side may send it |

Text messages are only for keep-alive: the agent sends `ping`, the runtime answers `pong`.

**Flow.** The Durable Object sends `REQ_HEAD`, the body chunks and `REQ_END`. The agent collects the whole request body, calls the local service, and sends back `RES_HEAD`, the chunks and `RES_END`. **Responses are streamed**, so server-sent events arrive tick by tick. With no agent connected the relay answers `503 tunnel offline`; waiting more than 30 s for a response head gives `504` and a `RESET`. Headers that only make sense hop by hop are filtered.

**Cancelling.** If the caller goes away, the Durable Object sends `RESET` and the agent aborts its local request. On Cloudflare previews this takes about 30 seconds to reach the local service; other requests are not blocked meanwhile.

**Keep-alive and hibernation.** The Durable Object answers `ping` with `pong` through the runtime's auto-response, which does not wake it. It uses the WebSocket Hibernation API, so it can sleep when idle and wake with empty memory while the socket stays open; it therefore picks the newest open agent socket each time instead of trusting memory. The agent pings every 20 s, drops a socket that misses a `pong` for 10 s and reconnects with backoff (`min(15 s, 1 s × 2^n)` with jitter).

## The agent

A background Node process, started detached so it outlives the terminal or editor that started it. One process serves all tunnels, one WebSocket each. It writes `agent.json` (pid, control port and a per-run token) and exposes a small HTTP control API on `127.0.0.1`: `GET /status`, `POST /tunnels`, `DELETE /tunnels/<name>` and `POST /shutdown`. Every call needs the token header, because a web page can still send a simple POST to a loopback port without a CORS check. The relay secret does not travel through the API: the agent reads `relay-secret` from disk itself. When another agent takes one of its tunnels (`replaced`), it stops that tunnel and does not reconnect, so two windows never fight over one address. An `agent.json` (or a lock file) written before the computer last started is treated as stale: after a restart its pid may belong to another process, so Everport never asks or kills that pid.

## Deploying to Cloudflare

Everport drives Cloudflare's `wrangler` tool, pinned to one exact version and run through `npx` (as `node npx-cli.js`, without a shell), with `CI=1` so it never opens a browser or asks questions. The one exception is `login`, which needs the browser.

- A preview is created with `wrangler preview --name <label> --worker-name <worker> --var TUNNEL:<label> --secrets-file <file> --json`. The real slug and URL are read from the JSON; hostnames are never computed.
- The first preview also creates the Worker, so it is created alone (creating several at once on a new Worker races). Later ones can run in parallel.
- Secrets travel in a private file that is deleted right after use, never through a shell pipe.
- After creation Everport checks `/__ep/version` first (is this our relay for this tunnel?) and only then does a real WebSocket handshake. The handshake connects as the agent and would push a running agent out, so it is used only at creation, never for health checks.
- A Worker that already exists under the chosen name and is not Everport's is never touched.
- Tunnel labels are normalised to ASCII `[a-z0-9-]` because Cloudflare rejects other characters with an unhelpful error; the original label is kept.

## Data on disk

In the data folder (see the README): `tunnels.json` (the tunnels you want, with the real URLs), `relay-secret` (random, one per Worker, owner-only where the OS allows), `agent.json` (running agent), lock files, and `logs/`. The secret never goes into `tunnels.json`. The lock keeps two processes (the CLI and a VS Code window, say) from changing tunnels at once; within one process, operations wait for each other instead.

## Tunnel states

| State     | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `active`  | the agent runs and the tunnel's WebSocket is connected                 |
| `stopped` | switched off, preview kept                                             |
| `down`    | the agent is not running                                               |
| `missing` | the preview is gone from Cloudflare (known after a health check)       |
| `failed`  | the last operation failed; the status carries a code, message and hint |

A health check adds `ok`, `not-found`, `mismatch` (a foreign Worker answers) or `unreachable`, and an `outdated` flag when the relay on Cloudflare runs older code than the installed Everport. A `not-found` answer makes the state `missing`, whatever the agent is doing. Every status read also sets `localDown` on an `active` tunnel whose local service refuses a TCP connection.

These are the names in the API and in `--json`. The CLI and the VS Code view show them to people as online, stopped, offline, missing and error (see [Tunnel states](reference.md#tunnel-states)). The core's hints name CLI commands; the extension rewords them as its own buttons, so both share one set of error codes.

## Security model

- A tunnel's public URL is public by design; anyone who knows it can reach the local service.
- Only an agent holding the secret can attach to a tunnel (HMAC token, constant-time comparison). Any other WebSocket upgrade, on any path, is refused with `501` by the Worker and again by the Durable Object.
- The VS Code settings `everport.nodePath` and `everport.startOnOpen` are read from user settings only, so a workspace cannot choose the program Everport runs or start tunnels.
- The secret lives in a local file, is not logged, and is not part of any URL. On Windows it relies on your user folder's permissions.
- The agent's control API is loopback-only and token-protected.
- Everport never reads or stores wrangler's login.
- Strangers probing URLs only spend your own request quota. Whether unknown addresses can create extra Durable Objects has not been tested.

## Testing

Unit tests run with fakes and need no network. The agent is tested over real sockets against a fake relay. Slower tests run the Worker in a local workerd, and real-Cloudflare tests (opt-in, they create and remove Workers named `ep-smoke-*`) run the whole product. The extension is tested inside a real VS Code. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Design choices

- **Your account, not a shared service.** A shared relay would make Everport an operated service: shared quota, an open proxy to abuse, privacy and terms-of-service questions, a single point of failure.
- **One preview per tunnel, not one Worker routing by path.** A preview has its own hostname, so apps with absolute paths such as `<script src="/app.js">` work. Path routing breaks silently for them.
- **No automatic fallback.** If Previews change, tunnels may stop. Everport does not quietly switch strategy, because that would change your URLs; the planned fallback is explicit and announced ([docs/contingency.md](contingency.md)).
- **A pinned wrangler through `npx`.** Previews are an open beta and the tool moves; pinning keeps behaviour predictable. An installed copy was slightly faster but sometimes missing a binary.
- **A background agent, not an in-editor process.** That is what lets tunnels outlive the editor.

## Known limits

Not implemented: two-way flow control, streaming uploads, WebSockets of the proxied app, a cap of concurrent requests per tunnel. Relay code updates and secret rotation are not implemented either. See the README for operational limits and what has been tested.
