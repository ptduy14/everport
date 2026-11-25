# Changelog

## 1.0.0

First public release.

- Give each local port a public URL that never changes, served by a relay in your own Cloudflare account.
- Log in to Cloudflare from the sidebar, add tunnels from a picker of listening ports, start and stop them, copy and open their URLs, check health, run the doctor and read the log.
- Tunnels keep running after VS Code closes.
- Clear states (Online, Stopped, Offline, Missing, Error) and a fix for every problem.
- Says when a tunnel is ready but your app is not running yet, and the public URL answers with a 502 that says so.
- Remove a tunnel from the list only when Cloudflare cannot be reached.
- Needs Node.js 22.12 or newer. Everport finds it on your `PATH` and in the folders of fnm, nvm and Volta, and **Everport: Select Node.js** lets you choose another.
- Works with the `everport` command-line tool, which manages the same tunnels.
