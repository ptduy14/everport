import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import http from 'node:http';
import { userInfo } from 'node:os';
import type { DockerPort, PortListener, PortProcess, PortScanner } from '../ports.js';

/** stdout even when the tool exits non-zero (lsof does when a pid is gone); '' when it cannot run. */
const run = (cmd: string, args: string[], timeout = 5000) =>
  new Promise<string>((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 32e6, timeout }, (_err, stdout) => resolve(stdout ?? ''));
  });

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

const DOCKER_FORMAT =
  '{{.Names}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Image}}';

/** Real scanner: netstat + CIM on Windows, ss + ps + /proc on Linux, lsof + ps on macOS. Read-only, no admin. */
export class NodePortScanner implements PortScanner {
  readonly platform: 'win32' | 'linux' | 'darwin';

  constructor(platform: NodeJS.Platform = process.platform) {
    this.platform = platform === 'win32' || platform === 'darwin' ? platform : 'linux';
  }

  currentUser(): string {
    if (this.platform === 'win32') return '';
    try {
      return String(userInfo().uid);
    } catch {
      return '';
    }
  }

  async listeners(): Promise<PortListener[]> {
    if (this.platform === 'win32') {
      const [v4, v6] = await Promise.all([
        run('netstat', ['-ano', '-p', 'TCP']),
        run('netstat', ['-ano', '-p', 'TCPv6']),
      ]);
      return parseNetstat(`${v4}\n${v6}`);
    }
    if (this.platform === 'linux') return parseSs(await run('ss', ['-ltnpH']));
    return parseLsofListen(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']));
  }

  async processes(detailPids: number[]): Promise<PortProcess[]> {
    if (this.platform === 'win32') {
      const ps =
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
      return parseCimProcesses(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 8000));
    }
    const pids = [...new Set(detailPids.filter((p) => p > 0))];
    if (this.platform === 'linux') {
      const procs = parsePsProcesses(await run('ps', ['-ww', '-eo', 'pid=,ppid=,uid=,args=']));
      const wanted = new Set(pids);
      await Promise.all(
        procs
          .filter((p) => wanted.has(p.pid))
          .map(async (p) => {
            const [exe, cwd] = await Promise.all([link(`/proc/${p.pid}/exe`), link(`/proc/${p.pid}/cwd`)]);
            if (exe) p.exe = basename(exe);
            if (cwd) p.cwd = cwd;
          }),
      );
      return procs;
    }
    // macOS: `args` splits badly on paths with spaces, so the name comes from `comm` (the full executable path).
    const [args, comm, cwds] = await Promise.all([
      run('ps', ['-ww', '-eo', 'pid=,ppid=,uid=,args=']),
      run('ps', ['-ww', '-eo', 'pid=,comm=']),
      pids.length ? run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'pn']) : Promise.resolve(''),
    ]);
    const exes = parsePidText(comm);
    const cwdOf = parseLsofCwd(cwds);
    return parsePsProcesses(args).map((p) => {
      const exe = exes.get(p.pid);
      const cwd = cwdOf.get(p.pid);
      return { ...p, ...(exe ? { name: basename(exe) } : {}), ...(cwd ? { cwd } : {}) };
    });
  }

  async docker(): Promise<Record<string, DockerPort>> {
    return parseDockerPs(await run('docker', ['ps', '--format', DOCKER_FORMAT], 3000));
  }

  probe(address: string, port: number): Promise<number> {
    return new Promise((resolve) => {
      const req = http.get({ host: address, port, path: '/', timeout: 400 }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(0);
      });
      req.on('error', () => resolve(0));
    });
  }
}

async function link(path: string): Promise<string> {
  try {
    return await readlink(path);
  } catch {
    return ''; // another user's process
  }
}

/** "*" (any), "[::1]", "127.0.0.53%lo" -> plain addresses. */
function cleanAddress(a: string): string {
  const s = a.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  return s === '*' ? '0.0.0.0' : s;
}

/**
 * Listening rows of `netstat -ano`. The state column is translated on non-English Windows, so a listener
 * is recognised by its empty remote address instead of the word LISTENING.
 */
export function parseNetstat(text: string): PortListener[] {
  const rows: PortListener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)\s*$/i.exec(line);
    if (m) rows.push({ address: cleanAddress(m[1]!), port: Number(m[2]), pid: Number(m[3]) });
  }
  return rows;
}

/** `ss -ltnpH`: `LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=12,fd=20))`. */
export function parseSs(text: string): PortListener[] {
  return text.split('\n').flatMap((line) => {
    const m = /^LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s*(.*)$/.exec(line.trim());
    if (!m) return [];
    const pid = /pid=(\d+)/.exec(m[3]!)?.[1];
    return [{ address: cleanAddress(m[1]!), port: Number(m[2]), pid: pid ? Number(pid) : 0 }];
  });
}

/** `lsof -F pn`: a `p<pid>` line, then `n<addr>:<port>` lines for that process. */
export function parseLsofListen(text: string): PortListener[] {
  const rows: PortListener[] = [];
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith('n')) {
      const m = /^n(.*):(\d+)$/.exec(line.trim());
      if (m) rows.push({ address: cleanAddress(m[1]!), port: Number(m[2]), pid });
    }
  }
  return rows;
}

/** `lsof -a -d cwd -F pn` -> pid -> working directory. */
export function parseLsofCwd(text: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith('n') && pid) map.set(pid, line.slice(1).trimEnd());
  }
  return map;
}

/** `ps -eo pid=,comm=` -> pid -> rest of the line. */
function parsePidText(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), m[2]!);
  }
  return map;
}

/** `ps -ww -eo pid=,ppid=,uid=,args=`. The name is the command line's first word (`comm` is a thread name on Linux). */
export function parsePsProcesses(text: string): PortProcess[] {
  return text.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (!m) return [];
    const cmd = m[4]!;
    const first = cmd.startsWith('"') ? cmd.slice(1, cmd.indexOf('"', 1)) : cmd.split(' ')[0]!;
    return [{ pid: Number(m[1]), ppid: Number(m[2]), user: m[3]!, name: basename(first), cmd }];
  });
}

export function parseCimProcesses(text: string): PortProcess[] {
  if (!text.trim()) return [];
  try {
    const raw = JSON.parse(text) as unknown;
    const rows = (Array.isArray(raw) ? raw : [raw]) as {
      ProcessId?: number;
      ParentProcessId?: number;
      Name?: string | null;
      CommandLine?: string | null;
    }[];
    return rows.flatMap((r) =>
      typeof r.ProcessId === 'number'
        ? [{ pid: r.ProcessId, ppid: r.ParentProcessId ?? 0, name: r.Name ?? '', cmd: r.CommandLine ?? '' }]
        : [],
    );
  } catch {
    return [];
  }
}

/** `docker ps` with DOCKER_FORMAT -> host port -> container. */
export function parseDockerPs(text: string): Record<string, DockerPort> {
  const out: Record<string, DockerPort> = {};
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [name = '', ports = '', project, dir, image] = line.split('|');
    if (!name) continue;
    for (const m of ports.matchAll(/:(\d+)->\d+\/tcp/g)) {
      out[m[1]!] = {
        name,
        ...(project ? { project } : {}),
        ...(dir ? { dir } : {}),
        ...(image ? { image } : {}),
      };
    }
  }
  return out;
}
