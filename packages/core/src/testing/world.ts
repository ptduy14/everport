import { EventBus, type EverportEvent } from '../events.js';
import { nullLogger } from '../logger.js';
import { createLayout, type Layout } from '../paths.js';
import { FakeFs } from './fake-fs.js';

/** Everything a module test needs: fake file system, event capture, linux-style layout. */
export function makeWorld() {
  const layout: Layout = createLayout({ platform: 'linux', env: {}, home: '/h' }, '/data');
  const fs = new FakeFs();
  const events = new EventBus();
  const seen: EverportEvent[] = [];
  events.on((e) => seen.push(e));
  const sleeps: number[] = [];
  return {
    layout,
    fs,
    events,
    seen,
    types: () => seen.map((e) => e.type),
    logger: nullLogger,
    sleeps,
    sleep: async (ms: number) => void sleeps.push(ms),
  };
}

export type World = ReturnType<typeof makeWorld>;
