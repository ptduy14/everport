import { describe, expect, it } from 'vitest';
import { connectToken } from '../token.js';
import { handleFetch } from './handler.js';
import type { RelayEnv } from './platform.js';
import { CODE_VERSION } from './version.js';

const SECRET = 'feedface'.repeat(8);

function makeEnv(over: Partial<RelayEnv> = {}) {
  const calls: { id: unknown; url: string }[] = [];
  const named: string[] = [];
  const env: RelayEnv = {
    RELAY: {
      idFromName: (name) => {
        named.push(name);
        return { name };
      },
      get: (id) => ({
        fetch: async (request) => {
          calls.push({ id, url: request.url });
          return new Response('from the durable object');
        },
      }),
    },
    TUNNEL: 'fe',
    SECRET,
    ...over,
  };
  return { env, calls, named };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://fe-everport.example.workers.dev${path}`, { headers });

describe('/__ep/version', () => {
  it('names the relay, its code version and its tunnel, and is not cached', async () => {
    const res = await handleFetch(get('/__ep/version'), makeEnv().env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'everport-relay', codeVersion: CODE_VERSION, tunnel: 'fe' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('still answers when the preview has no tunnel or secret yet, with a null tunnel', async () => {
    const { env } = makeEnv({ TUNNEL: undefined, SECRET: undefined });
    const res = await handleFetch(get('/__ep/version'), env);
    expect(await res.json()).toMatchObject({ name: 'everport-relay', tunnel: null });
  });
});

describe('a relay that is not configured', () => {
  it.each([
    ['no secret', { SECRET: undefined }],
    ['no tunnel', { TUNNEL: undefined }],
  ])('answers 500 for any other path with %s', async (_name, over) => {
    const { env, calls } = makeEnv(over);
    for (const path of ['/', '/__connect']) {
      const res = await handleFetch(get(path), env);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('relay not configured\n');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('/__connect', () => {
  it('answers 426 when the request is not a WebSocket upgrade', async () => {
    expect((await handleFetch(get('/__connect'), makeEnv().env)).status).toBe(426);
  });

  it.each([
    ['a wrong token', '?token=deadbeef'],
    ['no token', ''],
    ['a token for another tunnel', `?token=PLACEHOLDER`],
  ])('answers 403 with %s and never reaches the Durable Object', async (name, query) => {
    const { env, calls } = makeEnv();
    const token = name.includes('another') ? await connectToken(SECRET, 'be') : '';
    const res = await handleFetch(
      get(`/__connect${query.replace('PLACEHOLDER', token)}`, { upgrade: 'websocket' }),
      env,
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('hands a correctly signed upgrade to the Durable Object of this tunnel', async () => {
    const { env, calls, named } = makeEnv();
    const token = await connectToken(SECRET, 'fe');
    const res = await handleFetch(get(`/__connect?token=${token}`, { upgrade: 'websocket' }), env);
    expect(await res.text()).toBe('from the durable object');
    expect(named).toEqual(['fe']);
    expect(calls[0]!.url).toContain('/__connect?token=');
  });
});

describe('public requests', () => {
  it.each(['/', '/_next/webpack-hmr', '/x?token=whatever', '/__connect/extra'])(
    'refuses a WebSocket upgrade to %s with 501 and never reaches the Durable Object',
    async (path) => {
      const { env, calls } = makeEnv();
      for (const upgrade of ['websocket', 'WebSocket']) {
        const res = await handleFetch(get(path, { upgrade }), env);
        expect(res.status).toBe(501);
        expect(await res.text()).toContain('websockets of the local service are not supported');
      }
      expect(calls).toHaveLength(0);
    },
  );

  it('goes to the Durable Object named after the tunnel', async () => {
    const { env, calls, named } = makeEnv();
    const res = await handleFetch(get('/page.html?x=1'), env);
    expect(await res.text()).toBe('from the durable object');
    expect(named).toEqual(['fe']);
    expect(calls[0]!.url).toBe('https://fe-everport.example.workers.dev/page.html?x=1');
  });
});
