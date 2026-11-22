import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeRelayProbe } from './node-relay-probe.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A server standing in for a relay: it upgrades when the token is "good", answers 403 otherwise. */
async function stand(version: (() => { status: number; body: string }) | undefined = undefined): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === '/__ep/version') {
      const answer = version?.() ?? {
        status: 200,
        body: JSON.stringify({ name: 'everport-relay', codeVersion: '1', tunnel: 'fe' }),
      };
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
      return;
    }
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    socket.on('end', () => socket.end()); // a real relay closes its side when the caller closes
    const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
    if (token === 'good') {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    } else {
      socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    }
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('NodeRelayProbe.handshake', () => {
  it('returns 101 when the entrance accepts the token', async () => {
    expect(await new NodeRelayProbe().handshake(await stand(), 'good')).toBe(101);
  });

  it('returns 403 for a token that is refused', async () => {
    expect(await new NodeRelayProbe().handshake(await stand(), 'bad')).toBe(403);
  });

  it('returns 0 when nothing answers', async () => {
    const url = await stand();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    expect(await new NodeRelayProbe(2000).handshake(url, 'good')).toBe(0);
  });
});

describe('NodeRelayProbe.version', () => {
  it('reads the relay identity', async () => {
    expect(await new NodeRelayProbe().version(await stand())).toEqual({
      kind: 'relay',
      name: 'everport-relay',
      codeVersion: '1',
      tunnel: 'fe',
    });
  });

  it('reads a null tunnel as null', async () => {
    const url = await stand(() => ({ status: 200, body: '{"name":"everport-relay","codeVersion":"2","tunnel":null}' }));
    expect(await new NodeRelayProbe().version(url)).toMatchObject({ kind: 'relay', codeVersion: '2', tunnel: null });
  });

  it.each([
    ['a 404', { status: 404, body: 'Not found' }, 404],
    ['JSON from a stranger', { status: 200, body: '{"name":"someone-else","codeVersion":"1"}' }, 200],
    ['text that is not JSON', { status: 200, body: 'hello' }, 200],
    [
      'a relay-looking body with an error status',
      { status: 500, body: '{"name":"everport-relay","codeVersion":"1"}' },
      500,
    ],
  ])('says "other" for %s', async (_name, answer, status) => {
    const url = await stand(() => answer);
    expect(await new NodeRelayProbe().version(url)).toEqual({ kind: 'other', status });
  });

  it('says "unreachable" when nothing answers', async () => {
    const url = await stand();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    expect((await new NodeRelayProbe(2000).version(url)).kind).toBe('unreachable');
  });
});
