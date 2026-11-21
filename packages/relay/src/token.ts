// The agent proves it owns the relay secret with HMAC-SHA256("connect:" + tunnel), hex, lowercase.
// WebCrypto exists in both Workers and Node 22+, so the Worker and the agent share this file.

const encoder = new TextEncoder();

export async function connectToken(secret: string, tunnel: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`connect:${tunnel}`));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares in time that depends only on the length, not on where the strings differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyToken(secret: string, tunnel: string, token: string): Promise<boolean> {
  return timingSafeEqual(token, await connectToken(secret, tunnel));
}
