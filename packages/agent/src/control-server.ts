// The agent's control API: loopback HTTP, every call needs the per-run token.
// Without the token a web page could POST to 127.0.0.1 as a "simple request" and CORS would not stop it.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EverportError } from '@everport/core';
import { timingSafeEqual } from '@everport/relay';
import type { RelayAgent } from './agent.js';
import type { TunnelConfig } from './connection.js';

export const TOKEN_HEADER = 'x-everport-token';
/** Largest request body the API reads. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface ControlServerOptions {
  agent: RelayAgent;
  token: string;
  pid: number;
  /** Called after the response to POST /shutdown has been sent. */
  onShutdown: () => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BAD_REQUEST', 'request body is too large');
    parts.push(part as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'request body is not valid JSON');
  }
}

function parseTunnelConfig(body: unknown): TunnelConfig {
  const { name, url, target } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof name !== 'string' || typeof url !== 'string' || typeof target !== 'string') {
    throw new HttpError(400, 'BAD_REQUEST', 'body must be {"name": string, "url": string, "target": string}');
  }
  return { name, url, target };
}

export class AgentControlServer {
  private readonly server: Server;

  constructor(private readonly options: ControlServerOptions) {
    this.server = createServer((req, res) => void this.onRequest(req, res));
  }

  /** Listens on a free loopback port and returns it. */
  async start(): Promise<number> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const supplied = req.headers[TOKEN_HEADER];
      if (typeof supplied !== 'string' || !timingSafeEqual(supplied, this.options.token)) {
        throw new HttpError(401, 'UNAUTHORIZED', 'missing or wrong token');
      }
      const { pathname } = new URL(req.url ?? '/', 'http://agent');
      const { agent, pid } = this.options;

      if (req.method === 'GET' && pathname === '/status') {
        send(res, 200, { pid, ...agent.status() });
        return;
      }
      if (req.method === 'POST' && pathname === '/tunnels') {
        await agent.addTunnel(parseTunnelConfig(await readJson(req)));
        send(res, 200, { ok: true });
        return;
      }
      const tunnel = /^\/tunnels\/([^/]+)$/.exec(pathname);
      if (req.method === 'DELETE' && tunnel) {
        const name = decodeURIComponent(tunnel[1]!);
        if (!agent.removeTunnel(name)) throw new HttpError(404, 'TUNNEL_NOT_FOUND', `no tunnel named "${name}"`);
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && pathname === '/shutdown') {
        // Only after the answer has left: shutting down closes this very connection.
        res.once('finish', () => setImmediate(this.options.onShutdown));
        send(res, 200, { ok: true });
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', `no route for ${req.method} ${pathname}`);
    } catch (e) {
      if (e instanceof HttpError) {
        send(res, e.status, { error: { code: e.code, message: e.message } });
      } else if (e instanceof EverportError) {
        send(res, 400, { error: { code: e.code, message: e.message, hint: e.hint } });
      } else {
        send(res, 500, { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } });
      }
    }
  }
}
