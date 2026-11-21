import { describe, expect, it } from 'vitest';
import { EventBus, type EverportEvent } from './events.js';

describe('EventBus', () => {
  it('delivers events to listeners and supports unsubscribe', () => {
    const bus = new EventBus();
    const seen: EverportEvent[] = [];
    const off = bus.on((e) => seen.push(e));
    bus.emit('agent:starting', 'starting');
    bus.emit('tunnel:active', 'up', { id: 'a' });
    off();
    bus.emit('agent:ready', 'ignored');
    expect(seen).toEqual([
      { type: 'agent:starting', message: 'starting' },
      { type: 'tunnel:active', message: 'up', data: { id: 'a' } },
    ]);
  });

  it('keeps going when a listener throws', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on(() => {
      throw new Error('bad listener');
    });
    bus.on((e) => seen.push(e.type));
    bus.emit('agent:ready', 'ok');
    expect(seen).toEqual(['agent:ready']);
  });
});
