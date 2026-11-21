export const PRODUCT_NAME = 'everport';

export { normalizeTarget, InvalidTargetError } from './target.js';
export { EverportError, toEverportError, type EverportErrorCode } from './errors.js';
export { EventBus, type EverportEvent, type EverportEventType, type EverportEventListener } from './events.js';
export { FileLogger, nullLogger, type Logger } from './logger.js';
export { createLayout, resolveDataDir, joinPath, type Layout, type PathEnv } from './paths.js';
export type * from './ports.js';
export { NodeFileSystem } from './adapters/node-fs.js';
export { FetchHttpClient } from './adapters/node-http.js';
export { NodeProcessTable, windowsAgentCommandLine } from './adapters/node-process-table.js';
export {
  ConfigStore,
  configSchema,
  relaySchema,
  tunnelSchema,
  emptyConfig,
  findTunnel,
  migrate,
  maxTunnelNameLength,
  MAX_TUNNEL_NAME,
  NAME_PATTERN,
  type Config,
  type RelayConfig,
  type Tunnel,
} from './config-store.js';
export { FileLock, type Release } from './lock.js';
export { classifyPorts, type PortSnapshot, type PortGroup, type PortCandidate } from './port-classifier.js';
export { scanPorts, candidateTarget, type ScanOptions } from './port-scan.js';
export { NodePortScanner } from './adapters/node-port-scanner.js';
export { withWaitTiming, sumWaitMs, WAIT_PREFIX } from './timing.js';
