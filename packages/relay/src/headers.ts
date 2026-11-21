import type { HeaderList } from './frame.js';

// Headers that only mean something for one hop must not be forwarded.
const HOP_BY_HOP = [
  'connection',
  'host',
  'content-length',
  'upgrade',
  'transfer-encoding',
  'keep-alive',
  'te',
  'trailer',
];

const without = (headers: HeaderList, drop: Set<string>): HeaderList =>
  headers.filter(([name]) => !drop.has(name.toLowerCase()));

const TO_AGENT = new Set([...HOP_BY_HOP, 'accept-encoding']);
const TO_ORIGIN = new Set(HOP_BY_HOP);
const FROM_ORIGIN = new Set([...HOP_BY_HOP, 'content-encoding']);

/** Relay to agent: the agent asks the local service for an identity body, so accept-encoding goes too. */
export const filterForAgent = (headers: HeaderList): HeaderList => without(headers, TO_AGENT);

/** Agent to the local service. The agent then sets `accept-encoding: identity` itself. */
export const filterForOrigin = (headers: HeaderList): HeaderList => without(headers, TO_ORIGIN);

/** Local service back to the relay: content-encoding goes because the body was requested as identity. */
export const filterFromOrigin = (headers: HeaderList): HeaderList => without(headers, FROM_ORIGIN);
