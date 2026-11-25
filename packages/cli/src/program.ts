import { Command, CommanderError } from 'commander';
import { EverportError, type Everport, type StopOutcome, type TunnelStatus } from '@everport/core';
import { doctorLines, subdomainNotice, tunnelTable, tunnelWarnings } from './format.js';
import { ansi, lowerFirst, plain } from './paint.js';

const DOWN_MESSAGES: Record<StopOutcome, string> = {
  stopped: 'Stopped. Your tunnels keep their addresses; run "everport up" to bring them back.',
  killed:
    'Stopped (the agent did not exit and was killed). Your tunnels keep their addresses; run "everport up" to bring them back.',
  'not-running': 'Nothing to stop: the Everport agent is not running.',
};

/** The slice of Everport the CLI uses; lets tests pass a fake. */
export type Manager = Pick<
  Everport,
  'up' | 'down' | 'add' | 'remove' | 'start' | 'stop' | 'status' | 'doctor' | 'login' | 'isLoggedIn' | 'on'
>;

export interface CliContext {
  version: string;
  wranglerVersion: string;
  /** Called only by commands that need Everport, so --help and --version never touch the file system or the network. */
  createManager: () => Promise<Manager>;
  out: (line: string) => void;
  err: (line: string) => void;
  copy: (text: string) => Promise<void>;
  debug?: boolean;
  /** Colour the output (a person at a terminal, no NO_COLOR). */
  color?: boolean;
}

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const OK_CODES = new Set(['commander.help', 'commander.helpDisplayed', 'commander.version']);

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  let code = 0;
  const program = new Command();

  const task =
    <A extends unknown[]>(fn: (...args: A) => Promise<number | void>) =>
    async (...args: A) => {
      try {
        const c = await fn(...args);
        if (c) code = c;
      } catch (e) {
        code = reportError(e, ctx);
      }
    };

  /** Creates the manager and streams its progress events to stderr, keeping stdout clean for data. */
  const manager = async () => {
    const m = await ctx.createManager();
    m.on('event', (e) => ctx.err(`  ${e.message}`));
    return m;
  };

  const paint = ctx.color ? ansi : plain;
  const printTunnels = (tunnels: TunnelStatus[]) => {
    ctx.out(tunnelTable(tunnels, paint));
    for (const w of tunnelWarnings(tunnels, paint)) ctx.err(w);
  };

  program
    .name('everport')
    .description('Stable public URLs for your local services, through a relay in your own Cloudflare account')
    .version(`everport ${ctx.version} (wrangler ${ctx.wranglerVersion})`, '-v, --version')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.out(s.replace(/\n$/, '')),
      writeErr: (s) => ctx.err(s.replace(/\n$/, '')),
    });

  program
    .command('login')
    .description('Log in to Cloudflare in your browser (runs wrangler login; Everport never sees your credentials)')
    .action(
      task(async () => {
        const m = await manager();
        ctx.err('Checking your Cloudflare login (the first run downloads wrangler, which can take a minute)...');
        if (await m.isLoggedIn({ fresh: true })) {
          ctx.out('Already logged in to Cloudflare.');
          return;
        }
        ctx.err('Opening your browser to log in to Cloudflare...');
        await m.login();
        ctx.out('Logged in to Cloudflare.');
      }),
    );

  program
    .command('add <target>')
    .description('Add a tunnel to a local service (3000, localhost:3000 or a full URL)')
    .option('-l, --label <label>', 'a name for you, shown in lists and used in the address')
    .option('--copy', 'copy the URL to the clipboard')
    .action(
      task(async (target: string, opts: { label?: string; copy?: boolean }) => {
        const m = await manager();
        const isFirst = (await m.status()).length === 0;
        const t = await m.add({ target, ...(opts.label ? { label: opts.label } : {}) });
        ctx.out(t.url);
        printTunnels([t]);
        if (isFirst && t.url) ctx.err(subdomainNotice(t.url));
        if (t.state === 'down') ctx.err('The agent is not running yet. Run "everport up" to bring this tunnel online.');
        if (opts.copy) await copyUrl(ctx, t.url);
        return t.state === 'failed' ? EXIT_ERROR : 0;
      }),
    );

  program
    .command('up')
    .description('Start the agent and bring every enabled tunnel up (brings back a lost preview at the same address)')
    .option('--json', 'print the result as JSON')
    .action(
      task(async (opts: { json?: boolean }) => {
        const tunnels = await (await manager()).up();
        if (opts.json) ctx.out(JSON.stringify(tunnels, null, 2));
        else printTunnels(tunnels);
        return tunnels.some((t) => t.state === 'failed') ? EXIT_ERROR : 0;
      }),
    );

  program
    .command('down')
    .description('Stop the agent (your tunnels keep their addresses)')
    .action(
      task(async () => {
        ctx.out(DOWN_MESSAGES[await (await manager()).down()]);
      }),
    );

  program
    .command('ls')
    .alias('status')
    .description('List tunnels and their state')
    .option('--json', 'print as JSON')
    .option('--health', 'also ask each public address who answers')
    .action(
      task(async (opts: { json?: boolean; health?: boolean }) => {
        const tunnels = await (await ctx.createManager()).status({ health: opts.health ?? false });
        if (opts.json) ctx.out(JSON.stringify(tunnels, null, 2));
        else printTunnels(tunnels);
      }),
    );

  for (const [cmd, verb] of [
    ['start', 'Turn a tunnel on'],
    ['stop', 'Turn a tunnel off (keeps it and its address)'],
  ] as const) {
    program
      .command(`${cmd} <tunnel>`)
      .description(`${verb}; <tunnel> is an id or label`)
      .action(
        task(async (tunnel: string) => {
          const m = await manager();
          const t = await (cmd === 'start' ? m.start(tunnel) : m.stop(tunnel));
          printTunnels([t]);
          if (cmd === 'start' && t.state === 'down') ctx.err('The agent is not running yet. Run "everport up".');
          return t.state === 'failed' ? EXIT_ERROR : 0;
        }),
      );
  }

  program
    .command('rm <tunnel>')
    .alias('remove')
    .description('Remove a tunnel and its preview on Cloudflare; <tunnel> is an id or label')
    .option('--local', 'remove it from this computer only, when Cloudflare cannot be reached (the preview may remain)')
    .action(
      task(async (tunnel: string, opts: { local?: boolean }) => {
        const m = await manager();
        if (opts.local) {
          await m.remove(tunnel, { localOnly: true });
          ctx.out('Removed from this computer. Its preview may still be on Cloudflare.');
          return;
        }
        try {
          await m.remove(tunnel);
        } catch (e) {
          if (!(e instanceof EverportError) || ['TUNNEL_NOT_FOUND', 'LOCKED'].includes(e.code)) throw e;
          const local = `If Cloudflare stays out of reach, run "everport rm ${tunnel} --local" to remove it from this computer only.`;
          throw new EverportError(e.code, e.message, e.hint ? `${e.hint} ${local}` : local);
        }
        ctx.out('Removed. Its public address no longer works.');
      }),
    );

  program
    .command('copy <tunnel>')
    .description("Copy a tunnel's URL to the clipboard; <tunnel> is an id or label")
    .action(
      task(async (tunnel: string) => {
        const tunnels = await (await ctx.createManager()).status();
        const wanted = tunnel.toLowerCase();
        const found = tunnels.find((t) => t.id === tunnel) ?? tunnels.find((t) => t.label.toLowerCase() === wanted);
        if (!found)
          throw new EverportError('TUNNEL_NOT_FOUND', `No tunnel with id or label "${tunnel}"`, 'Run "everport ls".');
        ctx.out(found.url);
        await copyUrl(ctx, found.url);
      }),
    );

  program
    .command('doctor')
    .description('Check the setup and explain how to fix problems')
    .option('--json', 'print as JSON')
    .action(
      task(async (opts: { json?: boolean }) => {
        const checks = await (await ctx.createManager()).doctor();
        if (opts.json) ctx.out(JSON.stringify(checks, null, 2));
        else for (const l of doctorLines(checks, paint)) ctx.out(l);
        return checks.every((c) => c.ok) ? 0 : EXIT_ERROR;
      }),
    );

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return OK_CODES.has(e.code) ? 0 : EXIT_USAGE;
    return reportError(e, ctx);
  }
  if (argv.length === 0) return 0;
  return code;
}

async function copyUrl(ctx: CliContext, url: string): Promise<void> {
  try {
    await ctx.copy(url);
    ctx.err('Copied to the clipboard.');
  } catch (e) {
    ctx.err(`Could not copy: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function reportError(e: unknown, ctx: CliContext): number {
  if (e instanceof EverportError) {
    const paint = ctx.color ? ansi : plain;
    ctx.err(paint(`Error: ${e.message}`, 'red'));
    if (e.hint) ctx.err(`Fix: ${lowerFirst(e.hint)}`);
  } else {
    ctx.err(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    if (ctx.debug && e instanceof Error && e.stack) ctx.err(e.stack);
  }
  return EXIT_ERROR;
}
