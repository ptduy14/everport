import { once } from 'node:events';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@everport/core';
import type { Timings } from '../connection.js';

export const SECRET = 'a1b2c3'.repeat(10);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await sleep(10);
  }
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Short timings so keep-alive and reconnect tests run in milliseconds. */
export const FAST: Partial<Timings> = {
  pingIntervalMs: 40,
  pongTimeoutMs: 80,
  fastReconnectMs: 20,
  backoffBaseMs: 20,
  backoffMaxMs: 100,
};

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

export interface Origin {
  /** e.g. http://127.0.0.1:41234 */
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

export const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts);
};

/** A real local HTTP service for the agent to call. */
export async function startOrigin(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<Origin> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
