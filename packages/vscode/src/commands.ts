import * as vscode from 'vscode';
import {
  NodePortScanner,
  EverportError,
  normalizeTarget,
  scanPorts,
  type PortCandidate,
  type TunnelStatus,
  type EverportErrorCode,
} from '@everport/core';
import type { App } from './app.js';
import {
  pickedTarget,
  pickerEntries,
  pickerPlaceholder,
  sharedPorts,
  suggestedLabel,
  type PickEntry,
} from './port-items.js';
import {
  DOWN_MESSAGES,
  addedMessage,
  defaultLabel,
  failedSummary,
  healthMessage,
  labelError,
  removeDetail,
  removeQuestion,
  targetError,
} from './ui-text.js';

/** `start` only brings a tunnel up when the agent runs; otherwise start the agent too, so one click is enough. */
const needsUp = (t: TunnelStatus) => t.state === 'down' || t.state === 'missing';

export function registerCommands(ctx: vscode.ExtensionContext, app: App): void {
  const reg = (id: string, fn: (...args: never[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(`everport.${id}`, fn));

  reg('refresh', () => {
    app.resetEverport(); // also retries finding Node after the person installed it
    return app.refresh();
  });
  reg('showLog', () => app.showLog());

  reg('add', () =>
    app.run('Add tunnel', async () => {
      const ep = await app.ep();
      const loggedIn = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking your Cloudflare login…' },
        () => ep.isLoggedIn(),
      );
      if (!loggedIn) throw new EverportError('NOT_LOGGED_IN', 'You are not logged in to Cloudflare', '');

      const picked = await pickTarget(app);
      if (!picked) return;
      const { target: normalized, fallback } = picked;
      // Starts empty (not prefilled), so it does not look like step 1 again; empty means "use the default".
      const typed = await vscode.window.showInputBox({
        title: 'Add Tunnel · 2 of 2 · Label (optional)',
        prompt: `Name shown in the Tunnels list for ${normalized}. Leave empty to use "${fallback}".`,
        placeHolder: `${fallback} (press Enter to use it)`,
        ignoreFocusOut: true,
        validateInput: (v) => labelError(v, app.statuses, fallback),
      });
      if (typed === undefined) return; // Esc cancels the whole add
      const label = typed.trim() || fallback;
      const first = app.statuses.length === 0;
      // The first tunnel also creates the relay on Cloudflare, which takes about 20 s.
      await app.progress(`Adding ${label}…`, (e) => e.add({ target: normalized, label }));
      await app.refresh();
      const added = app.statuses.find((t) => t.label === label);
      if (added?.state === 'active') {
        const text = addedMessage(added, first);
        const pick = first
          ? await vscode.window.showWarningMessage(text, 'Copy URL', 'Open')
          : await vscode.window.showInformationMessage(text, 'Copy URL', 'Open');
        if (pick === 'Copy URL') await copyUrl(added);
        if (pick === 'Open') await openUrl(added);
      } else if (added?.state === 'failed' && added.error) {
        throw new EverportError(added.error.code as EverportErrorCode, added.error.message, added.error.hint);
      }
    }),
  );

  reg('upAll', () =>
    app.run('Start all', async () => {
      await app.progress('Starting tunnels…', (ep) => ep.up());
      await app.refresh();
      const failed = failedSummary(app.statuses);
      if (failed && (await vscode.window.showWarningMessage(failed, 'Show Log')) === 'Show Log') await app.showLog();
    }),
  );

  reg('downAll', () =>
    app.run('Stop all', async () => {
      const outcome = await app.progress('Stopping tunnels…', (ep) => ep.down());
      await app.refresh();
      void vscode.window.showInformationMessage(DOWN_MESSAGES[outcome]);
    }),
  );

  reg('start', (t: TunnelStatus) =>
    app.run(`Start ${t.label}`, () =>
      app.withBusy([t.id], async () => {
        const ep = await app.ep();
        if (needsUp(await ep.start(t.id))) await ep.up();
      }),
    ),
  );

  reg('stop', (t: TunnelStatus) =>
    app.run(`Stop ${t.label}`, () => app.withBusy([t.id], async () => void (await (await app.ep()).stop(t.id)))),
  );

  reg('retry', (t: TunnelStatus) =>
    app.run(`Retry ${t.label}`, () => app.withBusy([t.id], async () => void (await (await app.ep()).up()))),
  );

  reg('remove', (t: TunnelStatus) =>
    app.run(`Remove ${t.label}`, async () => {
      const pick = await vscode.window.showWarningMessage(
        removeQuestion(t),
        { modal: true, detail: removeDetail(t) },
        'Remove',
      );
      if (!pick) return;
      await app.withBusy([t.id], async () => (await app.ep()).remove(t.id));
    }),
  );

  reg('checkHealth', (t: TunnelStatus) =>
    app.run(`Check ${t.label}`, async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Checking ${t.label}…` },
        () => app.refresh({ health: true }),
      );
      const now = app.statuses.find((s) => s.id === t.id) ?? t;
      void vscode.window.showInformationMessage(healthMessage(now));
    }),
  );

  reg('copyUrl', (t: TunnelStatus) => copyUrl(t));
  reg('openUrl', (t: TunnelStatus) => openUrl(t));

  reg('login', () =>
    app.run('Log in to Cloudflare', async () => {
      // Cloudflare's own tool does the login in the browser; Everport never sees it.
      await app.progress('Logging in to Cloudflare… finish in the browser window that opened', (ep) => ep.login());
      app.setLoggedIn(true);
      await app.refresh();
      void vscode.window.showInformationMessage('Logged in to Cloudflare. Add a tunnel to get a public URL.');
    }),
  );

  reg('doctor', () =>
    app.run('Doctor', async () => {
      const checks = await app.progress('Checking your setup…', (ep) => ep.doctor());
      app.out.appendLine(`--- everport doctor ${new Date().toLocaleString()}`);
      for (const c of checks) {
        app.out.appendLine(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
        if (!c.ok && c.hint) app.out.appendLine(`      -> ${c.hint}`);
      }
      app.out.show(true);
      const failed = checks.filter((c) => !c.ok).length;
      const msg = failed
        ? `Doctor found ${failed} problem${failed > 1 ? 's' : ''}; details are in the output.`
        : 'Everything looks fine.';
      void (failed ? vscode.window.showWarningMessage(msg) : vscode.window.showInformationMessage(msg));
    }),
  );
}

async function copyUrl(t: TunnelStatus): Promise<void> {
  await vscode.env.clipboard.writeText(t.url);
  vscode.window.setStatusBarMessage(`$(copy) Copied ${t.url}`, 3000);
}

async function openUrl(t: TunnelStatus): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(t.url));
}

type PickItem = vscode.QuickPickItem & { entry: PickEntry };

/**
 * Step 1 of Add: running services fill in while the scan runs (about 1 s on Windows); typing works at once.
 * Resolves to the target URL and a default label, or undefined when cancelled.
 */
function pickTarget(app: App): Promise<{ target: string; fallback: string } | undefined> {
  const qp = vscode.window.createQuickPick<PickItem>();
  qp.title = 'Add Tunnel · 1 of 2 · Local service';
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = true;
  const state = { candidates: null as PortCandidate[] | null, showAll: false, typed: '' };
  let closed = false;
  const render = () => {
    if (closed) return; // the scan can finish after the picker is gone
    qp.busy = state.candidates === null;
    qp.placeholder = pickerPlaceholder(state.candidates);
    qp.items = pickerEntries(state).map((entry) =>
      entry.kind === 'separator'
        ? { label: entry.label, kind: vscode.QuickPickItemKind.Separator, entry }
        : {
            label: entry.label,
            ...('description' in entry ? { description: entry.description } : {}),
            ...('detail' in entry && entry.detail ? { detail: entry.detail } : {}),
            alwaysShow: entry.kind !== 'candidate',
            entry,
          },
    );
  };
  render();

  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
  void scanPorts(new NodePortScanner(), { workspaceFolders: folders, sharedPorts: sharedPorts(app.statuses) })
    .catch((e: unknown) => {
      app.out.appendLine(`port scan failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    })
    .then((candidates) => {
      state.candidates = candidates;
      render();
    });

  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { target: string; fallback: string } | undefined) => {
      done = true;
      resolve(v);
      qp.hide();
    };
    qp.onDidChangeValue((v) => {
      state.typed = v;
      render();
    });
    qp.onDidAccept(async () => {
      const entry = qp.selectedItems[0]?.entry ?? qp.activeItems[0]?.entry;
      if (!entry) return;
      if (entry.kind === 'showAll') {
        state.showAll = true;
        render();
      } else if (entry.kind === 'candidate') {
        finish({ target: pickedTarget(entry.candidate), fallback: suggestedLabel(entry.candidate, app.statuses) });
      } else if (entry.kind === 'typed') {
        finish({ target: entry.target, fallback: defaultLabel(entry.target) });
      } else if (entry.kind === 'manual') {
        done = true;
        qp.hide();
        resolve(await askTarget(qp.value));
      }
    });
    qp.onDidHide(() => {
      closed = true;
      qp.dispose();
      if (!done) resolve(undefined);
    });
    qp.show();
  });
}

async function askTarget(value: string): Promise<{ target: string; fallback: string } | undefined> {
  const target = await vscode.window.showInputBox({
    title: 'Add Tunnel · 1 of 2 · Local service (required)',
    prompt: 'Port or URL of the service to share',
    placeHolder: '3000, localhost:3000 or http://127.0.0.1:8080/api',
    value,
    ignoreFocusOut: true,
    validateInput: targetError,
  });
  if (!target) return undefined;
  const normalized = normalizeTarget(target);
  return { target: normalized, fallback: defaultLabel(normalized) };
}
