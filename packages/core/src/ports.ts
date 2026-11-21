// Ports: everything core needs from the outside world. Real adapters live in adapters/, fakes in testing/.

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
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
