import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  FrameError,
  FrameType,
  MAX_STREAM_ID,
  decodeFrame,
  decodeRequestHead,
  decodeResponseHead,
  encodeFrame,
  encodeRequestHead,
  encodeResponseHead,
  splitChunks,
  type FrameTypeValue,
} from './frame.js';

const bytes = (...n: number[]) => new Uint8Array(n);
const text = (s: string) => new TextEncoder().encode(s);

describe('encodeFrame and decodeFrame', () => {
  it.each(Object.entries(FrameType))('round-trips %s', (_name, type) => {
    const frame = decodeFrame(encodeFrame(type, 42, bytes(1, 2, 3)));
    expect(frame).toEqual({ type, streamId: 42, payload: bytes(1, 2, 3) });
  });

  it('writes the stream id big-endian after the type byte', () => {
    expect([...encodeFrame(FrameType.RES_DATA, 0x01020304, bytes(9))]).toEqual([5, 1, 2, 3, 4, 9]);
  });

  it('carries the largest stream id', () => {
    expect(decodeFrame(encodeFrame(FrameType.REQ_END, MAX_STREAM_ID)).streamId).toBe(MAX_STREAM_ID);
  });

  it('allows an empty payload', () => {
    const frame = decodeFrame(encodeFrame(FrameType.RES_END, 1));
    expect(frame.payload.length).toBe(0);
  });

  it('decodes an ArrayBuffer and a view that does not start at offset 0', () => {
    const encoded = encodeFrame(FrameType.REQ_DATA, 7, bytes(4, 5));
    expect(decodeFrame(encoded.buffer as ArrayBuffer).streamId).toBe(7);
    const padded = new Uint8Array([99, 99, ...encoded]);
    expect(decodeFrame(padded.subarray(2)).payload).toEqual(bytes(4, 5));
  });

  it.each([-1, 1.5, MAX_STREAM_ID + 1, Number.NaN])('refuses to encode stream id %s', (id) => {
    expect(() => encodeFrame(FrameType.REQ_END, id)).toThrow(FrameError);
  });

  it('refuses to encode an unknown type', () => {
    expect(() => encodeFrame(99 as FrameTypeValue, 1)).toThrow(FrameError);
  });

  it('rejects frames that are too short or of an unknown type', () => {
    expect(() => decodeFrame(bytes(1, 0, 0, 0))).toThrow(FrameError);
    expect(() => decodeFrame(new Uint8Array(0))).toThrow(FrameError);
    expect(() => decodeFrame(bytes(0, 0, 0, 0, 1))).toThrow(FrameError);
    expect(() => decodeFrame(bytes(8, 0, 0, 0, 1))).toThrow(FrameError);
  });
});

describe('request and response heads', () => {
  it('round-trips a request head, including non-ASCII text and repeated headers', () => {
    const head = {
      method: 'POST',
      path: '/tìm?q=cà phê',
      headers: [
        ['x-note', 'xin chào'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ] as [string, string][],
      hasBody: true,
    };
    expect(decodeRequestHead(encodeRequestHead(head))).toEqual(head);
  });

  it('round-trips a response head', () => {
    const head = { status: 201, headers: [['content-type', 'text/plain']] as [string, string][] };
    expect(decodeResponseHead(encodeResponseHead(head))).toEqual(head);
  });

  it.each([
    ['not JSON', text('{nope')],
    ['not an object', text('[]')],
    ['missing method', text('{"path":"/","headers":[],"hasBody":false}')],
    ['path without a leading slash', text('{"method":"GET","path":"x","headers":[],"hasBody":false}')],
    ['hasBody not a boolean', text('{"method":"GET","path":"/","headers":[],"hasBody":1}')],
    ['a header that is not a pair', text('{"method":"GET","path":"/","headers":[["a"]],"hasBody":false}')],
    ['a header value that is not text', text('{"method":"GET","path":"/","headers":[["a",1]],"hasBody":false}')],
  ])('rejects a request head that is %s', (_name, payload) => {
    expect(() => decodeRequestHead(payload)).toThrow(FrameError);
  });

  it.each([
    ['not JSON', text('x')],
    ['status missing', text('{"headers":[]}')],
    ['status below 100', text('{"status":99,"headers":[]}')],
    ['status above 599', text('{"status":600,"headers":[]}')],
    ['status not an integer', text('{"status":200.5,"headers":[]}')],
    ['headers missing', text('{"status":200}')],
  ])('rejects a response head with %s', (_name, payload) => {
    expect(() => decodeResponseHead(payload)).toThrow(FrameError);
  });
});

describe('splitChunks', () => {
  const size = (n: number) => splitChunks(new Uint8Array(n)).map((c) => c.length);

  it('gives no chunks for an empty body', () => {
    expect(size(0)).toEqual([]);
  });

  it('keeps a body of exactly one chunk whole', () => {
    expect(size(CHUNK_SIZE)).toEqual([CHUNK_SIZE]);
  });

  it('starts a second chunk one byte over the limit', () => {
    expect(size(CHUNK_SIZE + 1)).toEqual([CHUNK_SIZE, 1]);
  });

  it('reassembles to the original bytes', () => {
    const data = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
    const joined = new Uint8Array(data.length);
    let offset = 0;
    for (const chunk of splitChunks(data)) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    expect(joined).toEqual(data);
  });

  it('refuses a chunk size below 1', () => {
    expect(() => splitChunks(bytes(1), 0)).toThrow(RangeError);
  });
});
