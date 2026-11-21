// A relay on localhost that behaves like the Durable Object: Node HTTP + `ws` wrapped around RelayCore.
// It exists so the agent can be tested without Cloudflare. Test code only: never part of the relay bundle.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { HeaderList } from '../frame.js';
import { REPLACED, RelayCore, type AgentSocket, type PublicRequest } from '../relay-core.js';
import { verifyToken } from '../token.js';

export interface FakeRelayOptions {
  secret: string;
  tunnel: string;
  codeVersion?: string;
  headTimeoutMs?: number;
  /** Answer the agent's `ping` with `pong`, as the Durable Object's auto-response does. Default true. */
  autoPong?: boolean;
}

const toBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
};

export class FakeRelay {
  readonly core: RelayCore;
  private readonly server: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly agents = new Map<WebSocket, AgentSocket>();

  constructor(private readonly options: FakeRelayOptions) {
    this.core = new RelayCore(() => this.currentAgent(), { headTimeoutMs: options.headTimeoutMs });
    this.server = createServer((req, res) => void this.onRequest(req, res));
    this.server.on('upgrade', (req, socket) => void this.onUpgrade(req, socket));
  }

  /** Starts listening on a free port and returns the base URL, e.g. http://127.0.0.1:41234 */
  async start(): Promise<string> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const ws of this.agents.keys()) ws.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    this.server.close();
  }

  get connectedAgents(): number {
    return [...this.agents.keys()].filter((ws) => ws.readyState === WebSocket.OPEN).length;
  }

  private currentAgent(): AgentSocket | null {
    let found: AgentSocket | null = null;
    for (const [ws, agent] of this.agents) if (ws.readyState === WebSocket.OPEN) found = agent; // newest wins
    return found;
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://relay');
    if (pathname === '/__ep/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'everport-relay',
          codeVersion: this.options.codeVersion ?? '1',
          tunnel: this.options.tunnel,
        }),
      );
      return;
    }
    if (pathname === '/__connect') {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('expected websocket\n');
      return;
    }

    const headers: HeaderList = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push([req.rawHeaders[i]!, req.rawHeaders[i + 1]!]);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const publicRequest: PublicRequest = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
    };

    const out = await this.core.handle(publicRequest);
    res.writeHead(out.status, out.headers.flat());
    if (out.body === null) {
      res.end();
      return;
    }
    if (out.body instanceof Uint8Array) {
      res.end(out.body);
      return;
    }
    const reader = out.body.getReader();
    res.on('close', () => {
      if (!res.writableFinished) reader.cancel().catch(() => {});
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise<void>((resolve) => {
            res.once('drain', resolve);
            res.once('close', resolve);
          });
        }
      }
      res.end();
    } catch {
      res.destroy(); // the body broke midway: the client must see a broken response, not a short one
    }
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay');
    const reject = (code: number, message: string) => {
      socket.end(`HTTP/1.1 ${code} ${message}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    };
    if (url.pathname !== '/__connect') return reject(404, 'Not Found');
    const token = url.searchParams.get('token') ?? '';
    if (!(await verifyToken(this.options.secret, this.options.tunnel, token))) return reject(403, 'Forbidden');

    this.wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => this.attach(ws));
  }

  private attach(ws: WebSocket): void {
    // One agent per tunnel: the old agent's requests fail, and it is told to exit.
    this.core.dropAllStreams('agent replaced');
    for (const old of this.agents.keys()) old.close(1000, REPLACED);

    this.agents.set(ws, { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (data.toString() === 'ping' && this.options.autoPong !== false) ws.send('pong');
        return;
      }
      this.core.onAgentMessage(toBytes(data));
    });
    ws.on('close', () => {
      this.agents.delete(ws);
      if (this.currentAgent() === null) this.core.dropAllStreams('agent disconnected');
    });
    ws.on('error', () => {});
  }
}
