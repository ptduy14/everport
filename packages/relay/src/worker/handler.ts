// The Worker's fetch handler: identity, the agent's authenticated entrance, and the hand-off to the Durable Object.
import { verifyToken } from '../token.js';
import type { RelayEnv } from './platform.js';
import { CODE_VERSION, RELAY_NAME } from './version.js';

const text = (status: number, message: string): Response =>
  new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export async function handleFetch(request: Request, env: RelayEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/__ep/version') {
    return new Response(JSON.stringify({ name: RELAY_NAME, codeVersion: CODE_VERSION, tunnel: env.TUNNEL ?? null }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  const tunnel = env.TUNNEL;
  if (!tunnel || !env.SECRET) return text(500, 'relay not configured');

  const stub = env.RELAY.get(env.RELAY.idFromName(tunnel));

  if (url.pathname === '/__connect') {
    if (request.headers.get('upgrade') !== 'websocket') return text(426, 'expected websocket');
    if (!(await verifyToken(env.SECRET, tunnel, url.searchParams.get('token') ?? ''))) return text(403, 'forbidden');
  }
  return stub.fetch(request);
}
