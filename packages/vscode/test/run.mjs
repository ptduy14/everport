// Starts a real VS Code with the extension and test/suite.ts, then checks the detached child outlived VS Code.
// VSIX=<file> installs that packaged extension instead of loading the source folder.
// Usage: npm run test:vscode -w packages/vscode   (Linux CI: wrap in xvfb-run -a). VSCODE_VERSION picks the build.
/* global process, console */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
process.exit(failed ? 1 : 0);
