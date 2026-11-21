// Pure classification of listening ports for the port picker (input comes from a platform scan).
import type { DockerPort, PortListener, PortProcess } from './ports.js';

export interface PortSnapshot {
  platform: 'win32' | 'linux' | 'darwin';
  currentUser: string;
  workspaceFolders: string[];
  listeners: PortListener[];
  processes: PortProcess[];
  docker: Record<string, DockerPort>;
  /** port -> HTTP status of GET /, 0 = no answer; missing = not probed */
  http: Record<string, number>;
}

export type PortGroup = 'workspace' | 'docker' | 'dev' | 'other' | 'hidden';

export interface PortCandidate {
  port: number;
  address: string;
  pid: number;
  group: PortGroup;
  label: string;
  /** Project or container name, a good default tunnel label. */
  project?: string;
  detail: string;
  http?: number;
  shared: boolean;
}

const DEV_RUNTIMES =
  /^(node|bun|deno|python[0-9.]*|pythonw|java|dotnet|php|php-cgi|ruby|go|air|uvicorn|gunicorn|flask|rails|hugo|caddy|nginx|httpd|vite|next-server|esbuild)(\.exe)?$/i;
const DATABASES =
  /^(postgres|mysqld|mariadbd|mongod|redis-server|memurai|sqlservr|clickhouse|elasticsearch|rabbitmq|erl)(\.exe)?$/i;
const TUNNELS = /^(cloudflared|ngrok|code-tunnel|devtunnel|frpc|tailscaled|warp-svc)(\.exe)?$/i;
const SYSTEM =
  /^(system|svchost|lsass|wininit|services|spoolsv|smss|csrss|winlogon|searchindexer|nahimicservice|rapportd|controlcenter|sharingd|launchd|mdnsresponder|systemd.*|sshd|cupsd|avahi-daemon|dnsmasq|chronyd|rpcbind|containerd|dockerd)(\.exe)?$/i;
const WSLRELAY = /^wslrelay(\.exe)?$/i;
const VSCODE = /^(code(\.exe)?|code helper.*|electron)$/i;

type Proc = PortSnapshot['processes'][number];

const GROUP_ORDER: Record<PortGroup, number> = { workspace: 0, docker: 1, dev: 2, other: 3, hidden: 4 };

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** `node D:\x\fe-app\node_modules\...` -> "fe-app". The executable itself is skipped: `/usr/bin/node` is no project. */
function projectFrom(cmd: string): string {
  const args = cmd.trimStart().startsWith('"')
    ? cmd.slice(cmd.indexOf('"', cmd.indexOf('"') + 1) + 1)
    : cmd.trimStart().replace(/^\S+/, '');
  const m = /([^\\/"\s]+)[\\/](node_modules|dist|src|build|\.next|vendor|venv|\.venv|bin)[\\/]/i.exec(args);
  return m?.[1] ?? '';
}

function ancestry(pid: number, procs: Map<number, Proc>): Proc[] {
  const chain: Proc[] = [];
  for (let p = procs.get(pid), i = 0; p && i < 12; p = procs.get(p.ppid), i++) chain.push(p);
  return chain;
}

function pickAddress(rows: PortListener[]) {
  return rows.find((r) => r.address === '0.0.0.0') ?? rows.find((r) => r.address === '::') ?? rows[0]!;
}

export function classifyPorts(s: PortSnapshot, opts: { sharedPorts?: number[] } = {}): PortCandidate[] {
  const win = s.platform === 'win32';
  const norm = (x: string) => (win ? x.toLowerCase().replaceAll('/', '\\') : x);
  const sep = win ? '\\' : '/';
  const folders = s.workspaceFolders.map(norm);
  const inFolder = (path: string | undefined): boolean => {
    if (!path) return false;
    const p = norm(path);
    return folders.some((f) => p === f || p.startsWith(f.endsWith(sep) ? f : f + sep));
  };
  const cmdInWorkspace = (cmd: string) => {
    const c = norm(cmd);
    return folders.some((f) => f !== '' && c.includes(f));
  };

  const procs = new Map(s.processes.map((p) => [p.pid, p]));
  const shared = new Set(opts.sharedPorts ?? []);

  const byPort = new Map<number, typeof s.listeners>();
  for (const l of s.listeners) byPort.set(l.port, [...(byPort.get(l.port) ?? []), l]);

  const out: PortCandidate[] = [];
  for (const [port, rows] of byPort) {
    const l = pickAddress(rows);
    const proc = procs.get(l.pid);
    const name = proc?.name ?? '';
    const matches = (re: RegExp) => re.test(name) || (!!proc?.exe && re.test(proc.exe));

    let group: PortGroup;
    let label: string;
    let project = '';
    const reasons: string[] = [];

    const d = s.docker[String(port)];
    if (d) {
      label = d.project ? `${d.name} (${d.project})` : d.name;
      project = d.name;
      reasons.push('docker published port');
      if (d.dir && inFolder(d.dir)) {
        group = 'workspace';
        reasons.push('in this workspace');
      } else group = 'docker';
    } else if (win && proc && WSLRELAY.test(name)) {
      group = 'other';
      label = 'forwarded from WSL';
      reasons.push('forwarded from WSL');
    } else {
      label = name || '?';
      const chainNames = ancestry(l.pid, procs).map((c) => c.name.toLowerCase());
      const hiddenUnlessDb = (): PortGroup => (matches(DATABASES) ? 'other' : 'hidden');

      if (l.pid === 0 || !proc) {
        group = 'hidden';
        reasons.push(l.pid === 4 ? 'system process' : 'no owner info');
      } else if (matches(TUNNELS)) {
        group = 'hidden';
        reasons.push('tunnel tool');
      } else if (matches(SYSTEM) || l.pid === 4) {
        group = 'hidden';
        reasons.push('system process');
      } else if (win && chainNames.includes('services.exe') && !matches(DEV_RUNTIMES)) {
        group = hiddenUnlessDb();
        reasons.push('windows service');
      } else if (!win && proc.user && proc.user !== s.currentUser) {
        group = hiddenUnlessDb();
        reasons.push(`owned by ${proc.user}`);
      } else if (matches(DATABASES)) {
        group = 'other';
        reasons.push('database');
      } else if (VSCODE.test(name)) {
        group = 'dev';
        label = 'VS Code extension server';
        reasons.push('served by VS Code (e.g. Live Server)');
      } else if (matches(DEV_RUNTIMES)) {
        project = projectFrom(proc.cmd) || basename(proc.cwd ?? '');
        const inWs = cmdInWorkspace(proc.cmd) || inFolder(proc.cwd);
        group = inWs ? 'workspace' : 'dev';
        label = project ? `${name} · ${project}` : name;
        reasons.push(`dev runtime ${name}`);
        if (project) reasons.push(`project ${project}`);
        if (inWs) reasons.push('in this workspace');
      } else {
        group = 'other';
        reasons.push('unknown process');
      }
    }

    const probed = s.http[String(port)];
    const isShared = shared.has(port);
    if (group !== 'hidden' && !probed) reasons.push('no HTTP response');
    if (isShared) reasons.push('already shared');

    out.push({
      port,
      address: l.address,
      pid: l.pid,
      group,
      label,
      ...(project ? { project } : {}),
      detail: reasons.join('; '),
      ...(probed !== undefined ? { http: probed } : {}),
      shared: isShared,
    });
  }

  return out.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.port - b.port);
}
