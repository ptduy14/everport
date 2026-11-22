// Ports: everything core needs from the outside world. Real adapters live in adapters/, fakes in testing/.

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WranglerRunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Lets wrangler use the terminal (for `login`). Without it `CI=1` is set so that nothing ever prompts or opens a browser. */
  interactive?: boolean;
  env?: Record<string, string>;
}

/** Runs the pinned wrangler. Never rejects on a non-zero exit code. */
export interface WranglerRunner {
  run(args: string[], options?: WranglerRunOptions): Promise<CliResult>;
}

export type RelayVersionProbe =
  | { kind: 'relay'; name: string; codeVersion: string; tunnel: string | null }
  /** Something answered, but it is not an Everport relay (a stranger's Worker, or Cloudflare's 404). */
  | { kind: 'other'; status: number }
  | { kind: 'unreachable'; error: string };

export interface RelayProbe {
  /**
   * Tries the agent entrance with a token and returns the HTTP status (101 when accepted, 403 for a wrong token,
   * 0 when nothing answered). **A 101 connects as the agent: it pushes out a real agent of that tunnel.**
   */
  handshake(url: string, token: string): Promise<number>;
  /** GET /__ep/version: who answers at this address. Safe to call any time. */
  version(url: string): Promise<RelayVersionProbe>;
}

export interface AgentTunnelInfo {
  name: string;
  state: 'connecting' | 'connected' | 'replaced' | 'stopped';
  /** Why the last connection attempt failed, while it is still trying. */
  lastError?: string;
}

export interface AgentInfo {
  pid: number;
  tunnels: AgentTunnelInfo[];
}

/** The background agent as the facade sees it. The real adapter lives in the agent package. */
export interface AgentControl {
  /** What the running agent serves, or null when no agent runs. */
  status(): Promise<AgentInfo | null>;
  /** Starts the agent if it is not running. */
  ensureRunning(): Promise<void>;
  /** Serves a tunnel (or changes its target). The agent must be running. */
  addTunnel(tunnel: { name: string; url: string; target: string }): Promise<void>;
  /** Stops serving a tunnel. False when the agent had no such tunnel or no agent runs. */
  removeTunnel(name: string): Promise<boolean>;
  stop(): Promise<'stopped' | 'killed' | 'not-running'>;
}

export interface HttpResponse {
  status: number;
  body: Uint8Array;
}

export interface HttpClient {
  /** Rejects only on network failure or timeout, never on an HTTP status. */
  get(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<HttpResponse>;
}

export interface ProcessTable {
  /** Kills the process and all its descendants. */
  killTree(pid: number): Promise<void>;
  isAlive(pid: number): boolean;
  /** Starts `cmd args` fully detached from this process tree (double spawn); returns the child pid. */
  spawnDetached(cmd: string, args: string[], logFile: string): Promise<number | undefined>;
}

export interface FileSystem {
  /** null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  /** Creates parent directories as needed. */
  writeText(path: string, data: string): Promise<void>;
  /** Like writeText, but readable by the owner only (mode 0600 where the OS has modes). For tokens and secrets. */
  writeTextPrivate(path: string, data: string): Promise<void>;
  /** false when the file already exists. */
  writeTextExclusive(path: string, data: string): Promise<boolean>;
  appendText(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** false when there was nothing to remove. */
  remove(path: string): Promise<boolean>;
  /** true also for entries that exist but cannot be stat'ed (a Windows AF_UNIX socket gives EACCES). */
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number | null>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  chmodExecutable(path: string): Promise<void>;
  makeTempDir(prefix: string): Promise<string>;
  removeDir(path: string): Promise<void>;
}

export interface PortListener {
  address: string;
  port: number;
  /** 0 when the OS does not tell us the owner (another user's process, no permission). */
  pid: number;
}

export interface PortProcess {
  pid: number;
  ppid: number;
  /** Executable name from the command line (Linux/macOS) or the image name (Windows). */
  name: string;
  /** Real executable name when it differs (Linux symlinks such as redis-server). */
  exe?: string;
  cmd: string;
  user?: string;
  cwd?: string;
}

export interface DockerPort {
  name: string;
  project?: string;
  /** Compose working directory. */
  dir?: string;
  image?: string;
}

/** Read-only view of what listens on this machine, for the port picker. */
export interface PortScanner {
  readonly platform: 'win32' | 'linux' | 'darwin';
  currentUser(): string;
  listeners(): Promise<PortListener[]>;
  /** All processes; `detailPids` also get exe and cwd where the OS allows it. */
  processes(detailPids: number[]): Promise<PortProcess[]>;
  /** Host port -> container. Empty when Docker is absent or not running. */
  docker(): Promise<Record<string, DockerPort>>;
  /** HTTP status of `GET /`, 0 when nothing answers in time. */
  probe(address: string, port: number): Promise<number>;
}
