# Changelog

## 1.0.0

First public release.

- Give each local port a public URL that never changes, served by a relay in your own Cloudflare account.
- Log in to Cloudflare from the sidebar, add tunnels from a picker of listening ports, start and stop them, copy and open their URLs, check health, run the doctor and read the log.
- Tunnels keep running after VS Code closes.
- Needs Node.js 22.12 or newer. If VS Code cannot find it, set `everport.nodePath`.
- Works with the `everport` command-line tool, which manages the same tunnels.
