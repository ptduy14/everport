import { spawn } from 'node:child_process';

function clipboardCommand(platform: NodeJS.Platform, env: Record<string, string | undefined>): [string, string[]] {
  if (platform === 'win32') return ['clip', []];
  if (platform === 'darwin') return ['pbcopy', []];
  return env['WAYLAND_DISPLAY'] ? ['wl-copy', []] : ['xclip', ['-selection', 'clipboard']];
}

/** Copies text with the OS's own clipboard tool, so no extra dependency is needed. */
export function copyToClipboard(text: string): Promise<void> {
  const [cmd, args] = clipboardCommand(process.platform, process.env);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => reject(new Error(`Could not run "${cmd}". Copy the URL by hand.`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`"${cmd}" failed (exit ${code}).`))));
    child.stdin.end(text);
  });
}
