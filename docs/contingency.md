# If Cloudflare changes Previews

Everport's tunnels are **Workers Previews**, a Cloudflare feature that Cloudflare's own `wrangler preview` command labels open beta, so it can still change. This page says what would tell you something is wrong, what Everport does and does not do about it, and the plan for moving away from Previews. Read it before you register an Everport URL somewhere you cannot easily edit.

## Signs that Previews changed

- `everport ls --health` shows `not-found` for tunnels that worked, or `up` keeps having to recreate previews.
- `everport add` or `up` fails with a wrangler error that mentions `preview`, a changed command, or an API error that lasts for hours.
- Cloudflare announces a change to Workers Previews (check Cloudflare's changelog and the wrangler release notes).
- `everport doctor` reports a wrangler problem.

Run `everport doctor` first: it separates "no network" and "not logged in" from "the relay is gone".

## What Everport does today

- It reports the problem and does not guess. A lost preview is recreated by `everport up` at the same address; an address answered by something that is not your relay is left alone and reported.
- It pins one wrangler version, so a new wrangler cannot change behaviour under you. A change in the Cloudflare service itself is not covered by the pin.
- It **never switches strategy by itself**, because that would change your URLs without telling you.

## The plan: one Worker per tunnel

The fallback is to serve each tunnel from an ordinary Worker instead of a preview. **This is not implemented.** The plan, so you can judge it and so it can be built when needed:

1. **What stays the same.** Today a tunnel is the relay code, a `TUNNEL` variable, the relay secret and a Durable Object, deployed as a preview. An ordinary Worker can carry the same four things. Everport already names addresses `<name>-<worker>.<subdomain>.workers.dev`, and `<name>-<worker>` is always a valid Worker name (lowercase letters, digits and hyphens, at most 63 characters). A Worker called `<name>-<worker>` gets the same hostname as the preview `<name>` of the Worker `<worker>`. We checked this with a test: both produced the same hostname. **We did not check what happens to traffic during a real switch.**
2. **Announce first.** Everport would show a table of each tunnel's old and new address and wait for you to confirm. Where the hostnames are the same, the table says "unchanged".
3. **Switch one tunnel at a time.** Deploy the Worker, check that it answers as your relay, delete the preview, update the agent. Preview and Worker must not both exist on one hostname: the ordinary Worker wins, so delete the preview right after the check.
4. **Gap.** Expect a short interruption per tunnel while the agent reconnects. We have not measured it for this path.
5. **If an address does change,** update every place you registered it (webhook settings, OAuth redirect lists, connector configurations). `everport ls` prints the new addresses.

Costs and limits of this path are **not verified**: how many Workers a free account may hold, and whether each Worker's Durable Object counts against the daily limit differently. Check Cloudflare's current limits before relying on it.

## If you cannot wait

Everport is MIT licensed and the relay is a single small Worker (`packages/relay/src/worker`). You can deploy it yourself with wrangler as an ordinary Worker, set the `TUNNEL` variable and the `SECRET` secret, and point the agent at it. This is the same work the planned migration would automate.

## Tell us

If you hit one of the signs above, open an issue with the output of `everport doctor` and `everport ls --health` (remove anything private).
