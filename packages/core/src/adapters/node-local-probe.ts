import { connect } from 'node:net';
import type { LocalProbe } from '../ports.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/**
 * A plain TCP connect, not an HTTP request: a dev server that is still compiling answers HTTP slowly, but it accepts
 * the connection at once. Only targets on this computer are probed.
 */
export class NodeLocalProbe implements LocalProbe {
  constructor(private readonly timeoutMs = 1000) {}

  listening(target: string): Promise<boolean> {
    const u = new URL(target);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!LOOPBACK.has(host)) return Promise.resolve(true);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return new Promise((resolve) => {
      const socket = connect({ host: host === '0.0.0.0' ? '127.0.0.1' : host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(this.timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  }
}
