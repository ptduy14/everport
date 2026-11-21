// Wire format between the relay (Durable Object) and the agent: [type u8][streamId u32 big-endian][payload].
// Only Uint8Array, DataView and TextEncoder are used, so Workers and Node share this file without Buffer.

export const FrameType = {
  REQ_HEAD: 1,
  REQ_DATA: 2,
  REQ_END: 3,
  RES_HEAD: 4,
  RES_DATA: 5,
  RES_END: 6,
  RESET: 7,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

const KNOWN_TYPES = new Set<number>(Object.values(FrameType));

export const HEADER_SIZE = 5;
/** Largest body chunk carried by one REQ_DATA or RES_DATA frame. */
export const CHUNK_SIZE = 64 * 1024;
export const MAX_STREAM_ID = 0xffff_ffff;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export interface Frame {
  type: FrameTypeValue;
  streamId: number;
  /** A view into the decoded buffer, not a copy: copy it before keeping it past the next message. */
  payload: Uint8Array;
}

export type HeaderList = [string, string][];

export interface RequestHead {
  method: string;
  /** Path including the query string. */
  path: string;
  headers: HeaderList;
  hasBody: boolean;
}

export interface ResponseHead {
  status: number;
  headers: HeaderList;
}

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(type: FrameTypeValue, streamId: number, payload: Uint8Array = EMPTY): Uint8Array {
  if (!KNOWN_TYPES.has(type)) throw new FrameError(`unknown frame type ${type}`);
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_STREAM_ID) {
    throw new FrameError(`stream id out of range: ${streamId}`);
  }
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, streamId);
  out.set(payload, HEADER_SIZE);
  return out;
}

export function decodeFrame(data: ArrayBuffer | Uint8Array): Frame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < HEADER_SIZE) throw new FrameError(`frame too short (${bytes.length} bytes)`);
  const type = bytes[0]!;
  if (!KNOWN_TYPES.has(type)) throw new FrameError(`unknown frame type ${type}`);
  const streamId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  return { type: type as FrameTypeValue, streamId, payload: bytes.subarray(HEADER_SIZE) };
}

/** Cuts a body into chunks of at most `size` bytes (views, no copy). An empty body gives no chunks. */
export function splitChunks(data: Uint8Array, size: number = CHUNK_SIZE): Uint8Array[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('chunk size must be a positive integer');
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) chunks.push(data.subarray(offset, offset + size));
  return chunks;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isHeaderList = (v: unknown): v is HeaderList =>
  Array.isArray(v) &&
  v.every((h) => Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' && typeof h[1] === 'string');

function parseJson(payload: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(decoder.decode(payload));
  } catch {
    throw new FrameError(`${what} is not valid JSON`);
  }
}

export const encodeRequestHead = (head: RequestHead): Uint8Array => encoder.encode(JSON.stringify(head));

export function decodeRequestHead(payload: Uint8Array): RequestHead {
  const raw = parseJson(payload, 'request head');
  if (
    !isRecord(raw) ||
    typeof raw['method'] !== 'string' ||
    typeof raw['path'] !== 'string' ||
    !raw['path'].startsWith('/') ||
    typeof raw['hasBody'] !== 'boolean' ||
    !isHeaderList(raw['headers'])
  ) {
    throw new FrameError('invalid request head');
  }
  return { method: raw['method'], path: raw['path'], headers: raw['headers'], hasBody: raw['hasBody'] };
}

export const encodeResponseHead = (head: ResponseHead): Uint8Array => encoder.encode(JSON.stringify(head));

export function decodeResponseHead(payload: Uint8Array): ResponseHead {
  const raw = parseJson(payload, 'response head');
  const status = isRecord(raw) ? raw['status'] : undefined;
  if (
    !isRecord(raw) ||
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    !isHeaderList(raw['headers'])
  ) {
    throw new FrameError('invalid response head');
  }
  return { status, headers: raw['headers'] };
}
