# How Everport compares

Everport is built for one job: a public address for a local service that **does not change**, that several services can have at once, and that works when a browser on someone else's site loads your scripts or iframes.

This page says how other free options behave for that job and where each statement comes from. Products change; check the vendor before you decide.

| Option                  | Several fixed URLs, free       | Warning page in front of content           | Streaming (SSE)                         |
| ----------------------- | ------------------------------ | ------------------------------------------ | --------------------------------------- |
| **Everport**            | Yes, no domain                 | None                                       | Tick by tick                            |
| ngrok (free plan)       | One dev domain (docs)          | Yes, visitors click through (docs)         | Not checked                             |
| Cloudflare Quick Tunnel | No, a new URL every run (docs) | None                                       | Held back, arrives all at the end       |
| zrok.io (free plan)     | Yes                            | Yes, broke scripts and iframes from others | Tick by tick (measured behind a Worker) |
| Tailscale Funnel        | Up to 3 public ports (docs)    | Not checked                                | Not checked                             |

## Where each statement comes from

- **Our own runs (November 2026, one run each).** Everport and Cloudflare Quick Tunnel on the "warning page" and "streaming" columns; zrok on all three columns, with an older client version. For streaming we sent one event per second: through Everport the ticks arrived about one second apart (a 45 second stream delivered all 15 ticks); through Quick Tunnel five ticks arrived together at the end, after about six seconds. For the warning page we requested a script as a browser would: zrok's free plan returned an HTML warning page instead of the JavaScript.
- **Vendor documentation (marked "docs").** We did not test these.
  - ngrok free plan: one assigned dev domain, and a browser warning page that visitors click through, which can be skipped by clients that send a special header: [free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits.md).
  - Cloudflare Quick Tunnel: the hostname changes each time you create one, and Server-Sent Events are not supported: [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Our streaming run agrees with the second point.
  - Tailscale Funnel: public ports limited to 443, 8443 and 10000: [Funnel](https://tailscale.com/docs/features/tailscale-funnel).
- **"Not checked"** means we have not tested it and did not find it in the documentation.

## What we have not tested

- Everport inside ChatGPT's sandboxed iframe. It is the use Everport was designed for, and it has not been verified there.
- VS Code port forwarding and Microsoft Dev Tunnels. We make no statement about them.
- Long sessions, quota use over many hours, and the 100-preview limit.
