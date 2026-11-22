# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting: the **Security** tab → **Report a vulnerability**.

Include what you did, what you expected, and what happened. You can expect a first answer within a week.

## What Everport handles

- **Your Cloudflare login.** Everport runs Cloudflare's own `wrangler login` and never reads or stores its credentials.
- **The relay secret.** A random secret is stored in the data folder (`relay-secret`) and sent to Cloudflare as a secret of your relay. It decides who may connect an agent to a tunnel. On macOS and Linux the file is owner-only. **On Windows it is protected only by your user folder's permissions.** Rotating the secret is not implemented yet.
- **Public URLs.** While a tunnel runs, anyone with its URL can reach the service behind it. Stop tunnels you do not need and do not expose services that have no authentication. Strangers who guess a URL spend your Cloudflare request quota.
- **The agent's control API** listens on `127.0.0.1` only and requires a random per-run token.
- **Dependencies.** Everport ships no runtime dependencies in its packages (everything is bundled) and downloads one pinned version of wrangler through `npx` on first use.
- No telemetry is sent.

## Not verified yet

- We have not tested whether requests for unknown addresses can create extra Durable Objects in your account.
- macOS has not been tested. Linux (WSL2) passes the tests, including owner-only permissions on `relay-secret`, but has not been run against a real Cloudflare account.

Supported version: the latest release.
