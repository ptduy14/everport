import { NodeFileSystem } from '@everport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAgentState, readAgentState, removeAgentState, writeAgentState } from './state.js';
import { makeLayout } from './testing/daemon-helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const state = { pid: 4242, port: 41000, token: 'abc', startedAt: 1_700_000_000_000 };

describe('parseAgentState', () => {
  it('accepts a complete state', () => {
    expect(parseAgentState(JSON.stringify(state))).toEqual(state);
  });

  it.each([
    ['not JSON', '{nope'],
    ['a JSON array', '[]'],
    ['null', 'null'],
    ['pid missing', JSON.stringify({ ...state, pid: undefined })],
    ['pid zero', JSON.stringify({ ...state, pid: 0 })],
    ['pid not an integer', JSON.stringify({ ...state, pid: 1.5 })],
    ['port zero', JSON.stringify({ ...state, port: 0 })],
    ['port above 65535', JSON.stringify({ ...state, port: 70000 })],
    ['empty token', JSON.stringify({ ...state, token: '' })],
    ['token not text', JSON.stringify({ ...state, token: 5 })],
    ['startedAt missing', JSON.stringify({ ...state, startedAt: undefined })],
    ['half a file', '{"pid":4242,"po'],
  ])('rejects %s', (_name, text) => {
    expect(parseAgentState(text)).toBeNull();
  });
});

describe('agent.json on disk', () => {
  it('round-trips and leaves no temp file behind', async () => {
    const fs = new NodeFileSystem();
    const layout = await makeLayout(cleanup, false);
    await writeAgentState(fs, layout.agentStateFile, state);
    expect(await readAgentState(fs, layout.agentStateFile)).toEqual(state);
    expect(await fs.exists(`${layout.agentStateFile}.${state.pid}.tmp`)).toBe(false);
  });

  it('reads as nothing when the file is absent or unreadable', async () => {
    const fs = new NodeFileSystem();
    const layout = await makeLayout(cleanup, false);
    expect(await readAgentState(fs, layout.agentStateFile)).toBeNull();
    await fs.writeText(layout.agentStateFile, 'garbage');
    expect(await readAgentState(fs, layout.agentStateFile)).toBeNull();
  });

  it('removes the file, or leaves it when it now belongs to another agent', async () => {
    const fs = new NodeFileSystem();
    const layout = await makeLayout(cleanup, false);
    await writeAgentState(fs, layout.agentStateFile, state);

    await removeAgentState(fs, layout.agentStateFile, 9999);
    expect(await fs.exists(layout.agentStateFile)).toBe(true);

    await removeAgentState(fs, layout.agentStateFile, state.pid);
    expect(await fs.exists(layout.agentStateFile)).toBe(false);

    await writeAgentState(fs, layout.agentStateFile, state);
    await removeAgentState(fs, layout.agentStateFile);
    expect(await fs.exists(layout.agentStateFile)).toBe(false);
  });
});
