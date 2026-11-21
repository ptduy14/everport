import type { CliResult, HttpClient, HttpResponse } from '../ports.js';

export const ok = (stdout = '', stderr = ''): CliResult => ({ code: 0, stdout, stderr });
export const fail = (code: number, stderr = '', stdout = ''): CliResult => ({ code, stdout, stderr });

/** HttpClient answering from a url -> response map; an Error value simulates a network failure. */
export class FakeHttp implements HttpClient {
  requests: { url: string; headers: Record<string, string> }[] = [];
  /** Answer for URLs without a route (default: 404). */
  fallback: HttpResponse | Error | undefined;
  constructor(
    public routes: Record<
      string,
      HttpResponse | Error | ((headers: Record<string, string>) => HttpResponse | Error)
    > = {},
  ) {}

  async get(url: string, opts: { headers?: Record<string, string> } = {}): Promise<HttpResponse> {
    const headers = opts.headers ?? {};
    this.requests.push({ url, headers });
    const route = this.routes[url];
    if (route === undefined) {
      if (this.fallback instanceof Error) throw this.fallback;
      return this.fallback ?? { status: 404, body: new Uint8Array() };
    }
    const res = typeof route === 'function' ? route(headers) : route;
    if (res instanceof Error) throw res;
    return res;
  }
}

export const text = (status: number, body: string): HttpResponse => ({ status, body: new TextEncoder().encode(body) });
