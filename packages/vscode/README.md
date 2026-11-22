# Everport

Give each local service a public URL that never changes, from the VS Code sidebar. The URL lives on a small relay in **your own Cloudflare account**, and the tunnels keep running after you close VS Code.

Built for developers who register local services with outside platforms: webhooks, OAuth callbacks, AI connectors. Register the URL once, never paste it again.

## Get started

1. Open the Everport view in the Activity Bar and run **Log in to Cloudflare**. Cloudflare's own tool opens your browser; Everport never sees your login. You need a Cloudflare account (free to create).
2. Run **Add Tunnel**, pick a running port, and copy the URL. The first tunnel also creates the relay in your account and takes about 20 seconds.

The same tunnels are available from a terminal with the `everport` command (alias `ep`).

## What to know

- Everport needs **Node.js 22 or newer** on your computer (it runs the background agent and Cloudflare's tool). If VS Code cannot see it, set `everport.nodePath`.
- Your public addresses contain your Cloudflare `workers.dev` subdomain, which Cloudflare may have taken from your email address. Everport says so when you add your first tunnel.
- Starting tunnels makes your local services public. Tunnels do not start when VS Code opens unless you turn on `everport.startOnOpen`.
- Removing a tunnel deletes its address from Cloudflare; a new tunnel gets a new address.
- No telemetry.

Run **Everport: Run Doctor** if something does not work, and **Show Log** for details.
