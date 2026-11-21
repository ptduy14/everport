import { describe, expect, it } from 'vitest';
import type { HeaderList } from './frame.js';
import { filterForAgent, filterForOrigin, filterFromOrigin } from './headers.js';

const names = (h: HeaderList) => h.map(([n]) => n);
const sample: HeaderList = [
  ['Connection', 'keep-alive'],
  ['Host', 'x.workers.dev'],
  ['Content-Length', '10'],
  ['Upgrade', 'websocket'],
  ['Transfer-Encoding', 'chunked'],
  ['Keep-Alive', 'timeout=5'],
  ['TE', 'trailers'],
  ['Trailer', 'x'],
  ['Accept-Encoding', 'gzip'],
  ['Content-Encoding', 'gzip'],
  ['Content-Type', 'text/html'],
  ['Set-Cookie', 'a=1'],
  ['Set-Cookie', 'b=2'],
];

describe('header filters', () => {
  it('relay to agent drops hop-by-hop headers and accept-encoding, case-insensitively', () => {
    expect(names(filterForAgent(sample))).toEqual(['Content-Encoding', 'Content-Type', 'Set-Cookie', 'Set-Cookie']);
  });

  it('agent to the local service drops hop-by-hop headers only', () => {
    expect(names(filterForOrigin(sample))).toEqual([
      'Accept-Encoding',
      'Content-Encoding',
      'Content-Type',
      'Set-Cookie',
      'Set-Cookie',
    ]);
  });

  it('local service back to the relay drops hop-by-hop headers and content-encoding', () => {
    expect(names(filterFromOrigin(sample))).toEqual(['Accept-Encoding', 'Content-Type', 'Set-Cookie', 'Set-Cookie']);
  });

  it('keeps repeated headers and their order', () => {
    expect(
      filterForAgent(sample)
        .filter(([n]) => n === 'Set-Cookie')
        .map(([, v]) => v),
    ).toEqual(['a=1', 'b=2']);
  });
});
