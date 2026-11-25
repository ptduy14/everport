// The Durable Object's logic around RelayCore. It talks to Cloudflare only through DurableObjectStateLike
// and WorkerPlatform, so the class in index.ts stays a thin shell and this file can be tested in Node.
import type { HeaderList } from '../frame.js';
import { REPLACED, RelayCore, safeCloseCode, type AgentSocket, type PublicRequest } from '../relay-core.js';
import type { DurableObjectStateLike, WorkerPlatform, WorkerWebSocket } from './platform.js';

const OPEN = 1;
const isOpen = (ws: WorkerWebSocket): boolean => ws.readyState === undefined || ws.readyState === OPEN;

export class RelayObject {
  private readonly core: RelayCore;

  constructor(
    private readonly ctx: DurableObjectStateLike,
    private readonly platform: WorkerPlatform,
  ) {
    // Runs on every wake-up too: a hibernated object comes back with an empty memory but its sockets alive.
    ctx.setWebSocketAutoResponse(platform.autoResponsePair());
    this.core = new RelayCore(() => this.currentAgent());
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return this.proxy(request);
    // The Worker lets an upgrade through only on /__connect with a valid token; refuse any other as a second guard.
    if (new URL(request.url).pathname !== '/__connect') {
      return new Response('websockets of the local service are not supported\n', { status: 501 });
    }
    return this.acceptAgent();
  }

  webSocketMessage(_ws: WorkerWebSocket, message: string | ArrayBuffer): void {
    this.core.onAgentMessage(message);
  }

  webSocketClose(ws: WorkerWebSocket, code: number, reason: string): void {
    // A replaced agent closes after the new one is in: only fail requests when no agent socket is left.
    const stillConnected = this.ctx.getWebSockets().some((other) => other !== ws && isOpen(other));
    if (!stillConnected) this.core.dropAllStreams('agent disconnected');
    try {
      ws.close(safeCloseCode(code), reason);
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WorkerWebSocket): void {
    try {
      ws.close(1011, 'error');
    } catch {
      // already closed
    }
  }

  /** The newest open agent socket. Asked every time because the memory of a hibernated object is gone. */
  private currentAgent(): AgentSocket | null {
    const open = this.ctx.getWebSockets().filter(isOpen);
    const ws = open[open.length - 1];
    return ws ? { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) } : null;
  }

  private acceptAgent(): Response {
    // One agent per tunnel: requests of the old agent fail and it is told to exit.
    this.core.dropAllStreams('agent replaced');
    for (const old of this.ctx.getWebSockets()) {
      try {
        old.close(1000, REPLACED);
      } catch {
        // already closed
      }
    }
    const { client, server } = this.platform.newWebSocketPair();
    this.ctx.acceptWebSocket(server);
    return this.platform.upgradeResponse(client);
  }

  private async proxy(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;
    const publicRequest: PublicRequest = {
      method: request.method,
      path: url.pathname + url.search,
      headers: [...request.headers] as HeaderList,
      body: hasBody ? request.body : null,
    };
    const out = await this.core.handle(publicRequest);
    const headers = new Headers();
    for (const [name, value] of out.headers) headers.append(name, value);
    return new Response(out.body, { status: out.status, headers });
  }
}
