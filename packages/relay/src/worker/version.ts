/** Version of the relay code deployed to Cloudflare. Bump it whenever the Worker or Durable Object changes. */
export const CODE_VERSION = '1';

/** What /__ep/version answers as `name`: how a caller tells this Worker apart from a stranger's. */
export const RELAY_NAME = 'everport-relay';
