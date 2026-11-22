export type EverportErrorCode =
  | 'INVALID_TARGET'
  | 'INVALID_NAME'
  | 'NOT_LOGGED_IN'
  | 'WRANGLER_FAILED'
  | 'WORKER_NAME_TAKEN'
  | 'RELAY_MISMATCH'
  | 'AGENT_NOT_RUNNING'
  | 'AGENT_REPLACED'
  | 'RELAY_UNREACHABLE'
  | 'CONFIG_INVALID'
  | 'LOCKED'
  | 'TUNNEL_NOT_FOUND'
  | 'TUNNEL_EXISTS'
  | 'INTERNAL';

/** Error with a stable `code` for UIs and a `hint` telling the user what to do next. */
export class EverportError extends Error {
  readonly code: EverportErrorCode;
  readonly hint: string;

  constructor(code: EverportErrorCode, message: string, hint = '') {
    super(message);
    this.name = 'EverportError';
    this.code = code;
    this.hint = hint;
  }
}

export function toEverportError(e: unknown): EverportError {
  if (e instanceof EverportError) return e;
  return new EverportError('INTERNAL', e instanceof Error ? e.message : String(e));
}
