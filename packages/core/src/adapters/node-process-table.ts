import { execFile } from 'node:child_process';
import { uptime } from 'node:os';
import type { ProcessTable } from '../ports.js';

const run = (cmd: string, args: string[]) =>
  new Promise<{ ok: boolean; stdout: string }>((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout }));
  });

// Runs in a throwaway Node process that starts the child detached and exits, so the child
// leaves the caller's process tree. ELECTRON_RUN_AS_NODE makes this work when execPath is VS Code.
const LAUNCHER = `
const fs = require('fs');
const { spawn } = require('child_process');
const [cmd, logFile, ...args] = process.argv.slice(1);
const out = fs.openSync(logFile, 'a');
const c = spawn(cmd, args, { detached: true, windowsHide: true, stdio: ['ignore', out, out] });
c.unref();
process.stdout.write(String(c.pid));
`;

export class NodeProcessTable implements ProcessTable {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async killTree(pid: number): Promise<void> {
    if (this.platform === 'win32') {
      await run('taskkill', ['/F', '/T', '/PID', String(pid)]);
      return;
    }
    // The agent was spawned detached, so it leads its own process group.
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {
          // already gone
        }
      }
    };
    signal('SIGTERM');
    for (let i = 0; i < 10 && this.isAlive(pid); i++) await new Promise((r) => setTimeout(r, 200));
    if (this.isAlive(pid)) signal('SIGKILL');
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  bootTime(): number {
    return Date.now() - uptime() * 1000;
  }

  spawnDetached(cmd: string, args: string[], logFile: string): Promise<number | undefined> {
    if (this.platform === 'win32') return this.spawnDetachedWindows(cmd, args, logFile);
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ['-e', LAUNCHER, cmd, logFile, ...args],
        { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(Number(stdout.trim()) || undefined);
        },
      );
    });
  }

  /**
   * CreateProcess with handle inheritance would hand the agent every inheritable handle this process
   * holds, such as the pipe a shell gave us as stdout, and `everport up | cat` would never end. PowerShell's
   * Start-Process without redirection goes through ShellExecute, which inherits nothing; cmd.exe
   * redirects the agent's output to the log file.
   */
  private async spawnDetachedWindows(cmd: string, args: string[], logFile: string): Promise<number | undefined> {
    const line = windowsAgentCommandLine(cmd, args, logFile);
    const ps = `(Start-Process -FilePath cmd.exe -ArgumentList '${line.replaceAll("'", "''")}' -WindowStyle Hidden -PassThru).Id`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    if (!r.ok) throw new Error('could not start the agent through PowerShell');
    return Number(r.stdout.trim()) || undefined;
  }
}

/**
 * One argument for a `cmd.exe` line, quoted when it holds a space or a character cmd treats specially (`&`, `|`, `<`,
 * `>`, `^`, parentheses), as in a user folder named `Tom & Jo`. A `%` still expands, as it always does in cmd.
 */
export function quoteForCmd(arg: string): string {
  return arg === '' || /[\s&|<>^()"]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

/** The argument string for `cmd.exe`: runs `"cmd" args` with stdout and stderr appended to the log. */
export function windowsAgentCommandLine(cmd: string, args: string[], logFile: string): string {
  const quoted = [`"${cmd}"`, ...args.map(quoteForCmd)].join(' ');
  return `/c "${quoted} >> "${logFile}" 2>&1"`;
}
