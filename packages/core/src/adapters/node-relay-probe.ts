import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { RelayProbe, RelayVersionProbe } from '../ports.js';

const RELAY_NAME = 'everport-relay';

export class NodeRelayProbe implements RelayProbe {
  constructor(private readonly timeoutMs = 10_000) {}

  handshake(url: string, token: string): Promise<number> {
    return new Promise((resolve) => {
      const target = new URL('/__connect', url);
      target.searchParams.set('token', token);
      const request = (target.protocol === 'https:' ? https : http).request(target, {
        timeout: this.timeoutMs,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      });
      request.on('upgrade', (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.on('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on('timeout', () => {
        request.destroy();
        resolve(0);
      });
      request.on('error', () => resolve(0));
      request.end();
    });
  }

  async version(url: string): Promise<RelayVersionProbe> {
    try {
      const response = await fetch(new URL('/__ep/version', url), {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'cache-control': 'no-cache' },
      });
      const body: unknown = await response.json().catch(() => null);
      const { name, codeVersion, tunnel } = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      if (response.ok && name === RELAY_NAME && typeof codeVersion === 'string') {
        return { kind: 'relay', name, codeVersion, tunnel: typeof tunnel === 'string' ? tunnel : null };
      }
      return { kind: 'other', status: response.status };
    } catch (e) {
      return { kind: 'unreachable', error: e instanceof Error ? e.message : String(e) };
    }
  }
}
