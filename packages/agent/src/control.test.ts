import { stat } from 'node:fs/promises';
import { NodeFileSystem, type ProcessTable } from '@everport/core';
import { FakeRelay } from '@everport/relay/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayAgent } from './agent.js';
import { AgentClient } from './control-client.js';
import { MAX_BODY_BYTES, TOKEN_HEADER } from './control-server.js';
import { runDaemon } from './daemon.js';
import { writeAgentState } from './state.js';
import { makeLayout, startTestDaemon } from './testing/daemon-helpers.js';
import { FAST, SECRET, silentLogger, startOrigin, waitFor } from './testing/helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function boot() {
  const layout = await makeLayout(cleanup);
  const started = await startTestDaemon(layout, cleanup);
  const client = new AgentClient({ port: started.daemon.port, token: started.daemon.token });
  const raw = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${started.daemon.port}${path}`, init);
  return { layout, ...started, client, raw };
}

async function startRelay(tunnel: string) {
  const relay = new FakeRelay({ secret: SECRET, tunnel });
  const base = await relay.start();
  cleanup.push(() => relay.stop());
  return { relay, base };
}

describe('agent.json', () => {
  it('publishes pid, port and a token, and keeps the token private', async () => {
    const { layout, daemon } = await boot();
    const text = await new NodeFileSystem().readText(layout.agentStateFile);
    expect(JSON.parse(text!)).toMatchObject({ pid: process.pid, port: daemon.port, token: daemon.token });
    expect(daemon.token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') {
      expect((await stat(layout.agentStateFile)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('control API: the token', () => {
  it.each([
    ['no token', {}],
    ['a wrong token', { [TOKEN_HEADER]: 'nope' }],
  ])('answers 401 with %s', async (_name, headers) => {
    const { raw } = await boot();
    expect((await raw('/status', { headers })).status).toBe(401);
  });

  it('answers 401 to a text/plain POST from a web page, which CORS would not have stopped', async () => {
    const { raw } = await boot();
    const res = await raw('/shutdown', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('sends no CORS headers', async () => {
    const { raw, daemon } = await boot();
    const res = await raw('/status', { headers: { [TOKEN_HEADER]: daemon.token, origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('makes the client report AGENT_NOT_RUNNING for a wrong token', async () => {
    const { daemon } = await boot();
    const client = new AgentClient({ port: daemon.port, token: 'wrong' });
    await expect(client.status()).rejects.toMatchObject({ code: 'AGENT_NOT_RUNNING' });
  });
});

describe('control API: routes', () => {
  it('reports the agent status', async () => {
    const { client } = await boot();
    const status = await client.status();
    expect(status.pid).toBe(process.pid);
    expect(status.startedAt).toBeGreaterThan(0);
    expect(status.tunnels).toEqual([]);
  });

  it('adds a tunnel that then serves requests, and lists it', async () => {
    const { client } = await boot();
    const { relay, base } = await startRelay('fe');
    const origin = await startOrigin((_req, res) => void res.end('served'));
    cleanup.push(() => origin.close());
    await client.addTunnel({ name: 'fe', url: base, target: origin.url });
    await waitFor(() => relay.connectedAgents === 1);
    expect(await (await fetch(`${base}/x`)).text()).toBe('served');
    expect((await client.status()).tunnels).toMatchObject([{ name: 'fe', url: base, state: 'connected' }]);
  });

  it('removes a tunnel, and says so when there was none', async () => {
    const { client } = await boot();
    const { relay, base } = await startRelay('fe');
    await client.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await waitFor(() => relay.connectedAgents === 1);
    expect(await client.removeTunnel('fe')).toBe(true);
    await waitFor(() => relay.connectedAgents === 0);
    expect(await client.removeTunnel('fe')).toBe(false);
  });

  it('passes validation errors on with their code', async () => {
    const { client } = await boot();
    await expect(
      client.addTunnel({ name: 'Bad Name', url: 'http://127.0.0.1:9', target: 'http://127.0.0.1:9' }),
    ).rejects.toMatchObject({
      code: 'INVALID_NAME',
    });
    await expect(client.addTunnel({ name: 'fe', url: 'http://127.0.0.1:9', target: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_TARGET',
    });
  });

  it('answers 400 to a body that is not JSON or lacks fields, 413 to one that is too large, 404 to an unknown route', async () => {
    const { raw, daemon } = await boot();
    const headers = { [TOKEN_HEADER]: daemon.token, 'content-type': 'application/json' };
    expect((await raw('/tunnels', { method: 'POST', headers, body: '{nope' })).status).toBe(400);
    expect((await raw('/tunnels', { method: 'POST', headers, body: '{"name":"fe"}' })).status).toBe(400);
    const big = JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES + 1), url: 'u', target: 't' });
    expect((await raw('/tunnels', { method: 'POST', headers, body: big }).catch(() => ({ status: 413 }))).status).toBe(
      413,
    );
    expect((await raw('/nothing', { headers })).status).toBe(404);
    expect((await raw('/status', { method: 'DELETE', headers })).status).toBe(404);
  });
});

describe('shutting down', () => {
  it('stops on request: exit 0, agent.json gone, the port closed, sockets closed', async () => {
    const { layout, client, exits } = await boot();
    const { relay, base } = await startRelay('fe');
    await client.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await waitFor(() => relay.connectedAgents === 1);

    await client.shutdown();
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([0]);
    expect(await new NodeFileSystem().exists(layout.agentStateFile)).toBe(false);
    await expect(client.status()).rejects.toMatchObject({ code: 'AGENT_NOT_RUNNING' });
    await waitFor(() => relay.connectedAgents === 0);
  });

  it('can be called twice without exiting twice', async () => {
    const { daemon, exits } = await boot();
    await Promise.all([daemon.shutdown(), daemon.shutdown(3)]);
    expect(exits).toEqual([0]);
  });

  it('exits by itself once every tunnel was taken over by another agent', async () => {
    const { client, exits } = await boot();
    const { relay, base } = await startRelay('fe');
    await client.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await waitFor(() => relay.connectedAgents === 1);

    const rival = new RelayAgent({ secret: SECRET, logger: silentLogger, timings: FAST });
    cleanup.push(() => rival.stop());
    await rival.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([0]);
  });
});

describe('starting', () => {
  it.each([
    ['missing', false],
    ['empty', true],
  ])('refuses to start when the relay secret is %s', async (_name, empty) => {
    const layout = await makeLayout(cleanup, false);
    if (empty) await new NodeFileSystem().writeText(layout.relaySecretFile, '\n');
    await expect(
      runDaemon({ layout, fs: new NodeFileSystem(), logger: silentLogger, pid: process.pid }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('refuses to start while another agent is alive', async () => {
    const layout = await makeLayout(cleanup);
    const fs = new NodeFileSystem();
    await writeAgentState(fs, layout.agentStateFile, { pid: 4242, port: 1, token: 't', startedAt: 1 });
    const processTable = { isAlive: (pid: number) => pid === 4242 } as unknown as ProcessTable;
    await expect(runDaemon({ layout, fs, logger: silentLogger, pid: process.pid, processTable })).rejects.toMatchObject(
      { code: 'LOCKED' },
    );
  });

  it('takes over an agent.json whose agent is dead', async () => {
    const layout = await makeLayout(cleanup);
    const fs = new NodeFileSystem();
    await writeAgentState(fs, layout.agentStateFile, { pid: 4242, port: 1, token: 't', startedAt: 1 });
    const processTable = { isAlive: () => false } as unknown as ProcessTable;
    const daemon = await runDaemon({ layout, fs, logger: silentLogger, pid: process.pid, processTable });
    cleanup.push(() => daemon.shutdown());
    expect((await new AgentClient({ port: daemon.port, token: daemon.token }).status()).pid).toBe(process.pid);
  });
});
