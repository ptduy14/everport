// Starts a real VS Code with the extension and test/suite.ts, then checks the detached child outlived VS Code.
// VSIX=<file> installs that packaged extension instead of loading the source folder.
// Usage: npm run test:vscode -w packages/vscode   (Linux CI: wrap in xvfb-run -a). VSCODE_VERSION picks the build.
/* global process, console, fetch, AbortSignal */
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'ep-vscode-test-'));
const out = join(tmp, 'result.json');

const vsix = process.env.VSIX ? resolve(process.env.VSIX) : '';
const version = process.env.VSCODE_VERSION || 'stable';
const userData = ['--user-data-dir', join(tmp, 'user-data')];
let devPath = pkg;
let launchArgs = [tmp, '--disable-extensions', ...userData, '--skip-welcome'];
// VSCODE_EXECUTABLE=<Code.exe> reuses an installed VS Code instead of downloading one.
let vscodeExecutablePath = process.env.VSCODE_EXECUTABLE || undefined;

// EVERPORT_E2E_SURVIVE=1: the extension host adds a tunnel on the real Cloudflare account and VS Code then exits
// without stopping anything. The local service lives here (not in VS Code) so it can answer afterwards.
const survive = process.env.EVERPORT_E2E_SURVIVE === '1';
const surviveOut = join(tmp, 'survive.json');
const surviveWorker = `ep-smoke-${Math.random().toString(16).slice(2, 8)}`;
let origin;
let originPort = 0;
if (survive) {
  origin = createServer((_q, s) => s.end('hello survive'));
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  originPort = origin.address().port;
}

let failed = false;
try {
  if (vsix) {
    vscodeExecutablePath ??= await downloadAndUnzipVSCode(version);
    const extDir = join(tmp, 'extensions');
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    const r = spawnSync(cli, [...cliArgs, '--extensions-dir', extDir, ...userData, '--install-extension', vsix], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) throw new Error('installing the VSIX failed');
    // Nothing is loaded from source: the host only needs some folder to call the development path.
    devPath = join(tmp, 'empty-dev');
    mkdirSync(devPath);
    writeFileSync(
      join(devPath, 'package.json'),
      JSON.stringify({ name: 'empty', version: '0.0.0', engines: { vscode: '*' } }),
    );
    launchArgs = [tmp, '--extensions-dir', extDir, ...userData, '--skip-welcome'];
  }
  await runTests({
    version,
    ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
    extensionDevelopmentPath: devPath,
    extensionTestsPath: join(pkg, 'dist-test', 'suite.js'),
    launchArgs,
    extensionTestsEnv: {
      EVERPORT_DATA_DIR: join(tmp, 'ep-data'),
      EVERPORT_TEST_OUT: out,
      EVERPORT_E2E_CLOUDFLARE: process.env.EVERPORT_E2E_CLOUDFLARE ?? '',
      EVERPORT_E2E_SURVIVE: survive ? '1' : '',
      EVERPORT_SURVIVE_PORT: String(originPort),
      EVERPORT_SURVIVE_OUT: surviveOut,
      EVERPORT_SURVIVE_WORKER: surviveWorker,
    },
  });
} catch (e) {
  console.error('VS Code tests failed:', e);
  failed = true;
}

if (!failed) {
  const { pid, execPath } = JSON.parse(readFileSync(out, 'utf8'));
  console.log(`extension host execPath: ${execPath}`);
  let alive;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (e) {
    alive = e.code === 'EPERM';
  }
  console.log(
    `${alive ? 'ok  ' : 'FAIL'} detached child ${pid} is ${alive ? 'still running' : 'gone'} after VS Code exited`,
  );
  if (!alive) failed = true;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

if (survive) {
  // VS Code has exited: the tunnel must still answer through Cloudflare, served by the agent it left behind.
  let agentPid;
  try {
    agentPid = JSON.parse(readFileSync(join(tmp, 'ep-data', 'agent.json'), 'utf8')).pid;
  } catch {
    // no agent file
  }
  if (!failed && existsSync(surviveOut)) {
    const { url } = JSON.parse(readFileSync(surviveOut, 'utf8'));
    let body;
    try {
      body = await (await fetch(url, { signal: AbortSignal.timeout(20_000) })).text();
    } catch (e) {
      body = String(e);
    }
    const ok = body === 'hello survive';
    console.log(`${ok ? 'ok  ' : 'FAIL'} after VS Code exited, ${url} answers (${ok ? 'hello survive' : body})`);
    let agentAlive;
    try {
      process.kill(agentPid, 0);
      agentAlive = true;
    } catch (e) {
      agentAlive = e.code === 'EPERM';
    }
    console.log(
      `${agentAlive ? 'ok  ' : 'FAIL'} the agent (pid ${agentPid}) is ${agentAlive ? 'still running' : 'gone'}`,
    );
    if (!ok || !agentAlive) failed = true;
  } else if (!failed) {
    console.log('FAIL the extension host did not report a tunnel');
    failed = true;
  }
  // Clean up whatever happened: stop the agent, delete the Worker (and with it the preview), close the service.
  try {
    if (agentPid) {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/F', '/T', '/PID', String(agentPid)], { stdio: 'ignore' });
      else process.kill(agentPid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
  const nodeDir = dirname(process.execPath);
  const npxCli =
    process.platform === 'win32'
      ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
      : join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const del = spawnSync(
    process.execPath,
    [npxCli, '-y', 'wrangler@4.166.0', 'delete', '--name', surviveWorker, '--force'],
    {
      env: { ...process.env, CI: '1' },
      encoding: 'utf8',
    },
  );
  console.log(`${del.status === 0 ? 'ok  ' : 'FAIL'} the Worker ${surviveWorker} was deleted`);
  if (del.status !== 0) failed = true;
  origin.close();
}

try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch (e) {
  // VS Code's helpers can hold files a little after exit on Windows; a leftover temp folder is not a test failure
  console.log(`note: could not remove ${tmp}: ${e.code ?? e}`);
}
process.exit(failed ? 1 : 0);
