import type { HttpClient, HttpResponse } from '../ports.js';

export class FetchHttpClient implements HttpClient {
  async get(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<HttpResponse> {
    const res = await fetch(url, {
      headers: opts.headers ?? {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  }
}
