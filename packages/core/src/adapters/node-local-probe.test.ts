import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeLocalProbe } from './node-local-probe.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listen(): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

/** A port that was just free: nothing listens there. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('NodeLocalProbe', () => {
  it('says yes when something listens at the target, whatever the path', async () => {
    const port = await listen();
    expect(await new NodeLocalProbe().listening(`http://127.0.0.1:${port}/api?x=1`)).toBe(true);
    expect(await new NodeLocalProbe().listening(`http://localhost:${port}`)).toBe(true);
  });

  it('says no when nothing listens there', async () => {
    expect(await new NodeLocalProbe(500).listening(`http://127.0.0.1:${await closedPort()}`)).toBe(false);
  });

  it('does not probe a target on another computer', async () => {
    expect(await new NodeLocalProbe().listening('http://192.0.2.1:3000')).toBe(true);
  });
});
