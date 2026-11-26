export class InvalidTargetError extends Error {
  constructor(input: string, reason: string) {
    super(`Invalid target "${input}": ${reason}`);
    this.name = 'InvalidTargetError';
  }
}

/**
 * Turns user input ("3000", "localhost:3000", "http://host:3000/api") into the URL the share proxies to.
 * A bare port maps to 127.0.0.1, not localhost, which may resolve to ::1 while the service listens on IPv4.
 */
export function normalizeTarget(input: string): string {
  const raw = input.trim();
  if (raw === '') throw new InvalidTargetError(input, 'empty');
  if (/^\d+$/.test(raw) && !isValidPort(Number(raw))) {
    throw new InvalidTargetError(input, 'port must be between 1 and 65535');
  }
  // A bare word ("abc") is most likely a typo, not a host: ask for a port or a full URL.
  if (/^[a-z0-9-]+$/i.test(raw) && !/^\d+$/.test(raw) && raw.toLowerCase() !== 'localhost') {
    throw new InvalidTargetError(input, 'not a port or an address; use 3000, localhost:3000 or http://host:3000');
  }

  const withScheme = /^\d+$/.test(raw) ? `http://127.0.0.1:${raw}` : /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidTargetError(input, 'not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidTargetError(input, 'only http and https are supported');
  }
  if (url.port !== '' && !isValidPort(Number(url.port))) {
    throw new InvalidTargetError(input, 'port must be between 1 and 65535');
  }

  return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/** `localhost:3000` for a plain local HTTP target; the full URL when it has https, another host or a path. */
export function shortTarget(target: string): string {
  const u = new URL(target);
  const plain = u.protocol === 'http:' && LOOPBACK.includes(u.hostname) && u.pathname === '/' && !u.search;
  return plain ? `localhost:${u.port || '80'}` : target;
}
