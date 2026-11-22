// Entry of the relay Worker that is bundled into dist/worker.js and deployed to the user's Cloudflare account.
import { DurableObject } from 'cloudflare:workers';
import { handleFetch } from './handler.js';
import type { RelayEnv, WorkerPlatform, WorkerWebSocket } from './platform.js';
import { RelayObject } from './relay-object.js';

declare const WebSocketPair: new () => { 0: WorkerWebSocket; 1: WorkerWebSocket };
declare const WebSocketRequestResponsePair: new (request: string, response: string) => unknown;

const platform: WorkerPlatform = {
  newWebSocketPair: () => {
    const pair = new WebSocketPair();
    return { client: pair[0], server: pair[1] };
  },
  autoResponsePair: () => new WebSocketRequestResponsePair('ping', 'pong'),
  upgradeResponse: (client) => new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit),
};

export class Relay extends DurableObject<RelayEnv> {
  private readonly object: RelayObject;

  constructor(ctx: DurableObject<RelayEnv>['ctx'], env: RelayEnv) {
    super(ctx, env);
    this.object = new RelayObject(ctx, platform);
  }

  fetch(request: Request): Promise<Response> {
    return this.object.fetch(request);
  }

  webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer): void {
    this.object.webSocketMessage(ws, message);
  }

  webSocketClose(ws: WorkerWebSocket, code: number, reason: string): void {
    this.object.webSocketClose(ws, code, reason);
  }

  webSocketError(ws: WorkerWebSocket): void {
    this.object.webSocketError(ws);
  }
}

export default {
  fetch: (request: Request, env: RelayEnv): Promise<Response> => handleFetch(request, env),
};
