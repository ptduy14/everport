import * as vscode from 'vscode';
import {
  NodeLocalProbe,
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
  sharedNames,
  sharedPorts,
  suggestedLabel,
  type PickEntry,
} from './port-items.js';
import {
  DOWN_MESSAGES,
  addedMessage,
  startedWaitingMessage,
  waitingForApp,
  defaultLabel,
  doctorReport,
  errorText,
  healthMessage,
  labelError,
  LOGGED_IN_TEXT,
  LOGIN_WAIT_TEXT,
  LOGIN_WAIT_TITLE,
  REMOVE_BUTTON,
  REMOVE_LOCAL_BUTTON,
  REMOVE_LOCAL_DETAIL,
  removeDetail,
  removeLocalQuestion,
  removeQuestion,
  targetError,
  urlPreview,
} from './ui-text.js';
import { STATE_WORDS } from './view-model.js';

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
  reg('selectNode', () => app.selectNode());

  reg('add', () =>
    app.run('Add tunnel', async () => {
      const ep = await app.ep();
      const loggedIn = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking your Cloudflare login…' },
        () => ep.isLoggedIn(),
      );
      if (!loggedIn) throw new EverportError('NOT_LOGGED_IN', 'You are not logged in to Cloudflare', '');

      const picked = await pickTarget(app);
      if (!picked) return app.log('info', '  Cancelled');
      const { target: normalized, fallback } = picked;
      // Starts empty (not prefilled), so it does not look like step 1 again; empty means "use the default".
      const typed = await vscode.window.showInputBox({
        title: 'Add Tunnel · 2 of 2 · Name',
        prompt: `Part of the public URL, and it can't be changed later. Press Enter to keep "${fallback}".`,
        placeHolder: `${fallback} (press Enter to use it)`,
        ignoreFocusOut: true,
        validateInput: (v) => {
          const error = labelError(v, app.statuses, fallback);
          if (error) return error;
          const url = urlPreview(v.trim() || fallback, app.statuses, app.workerName);
          return { message: `Public URL: ${url}`, severity: vscode.InputBoxValidationSeverity.Info };
        },
      });
      if (typed === undefined) return app.log('info', '  Cancelled'); // Esc cancels the whole add
      const label = typed.trim() || fallback;
      const first = app.statuses.length === 0;
      app.log('info', `  ${label} → ${normalized}`);
      const started = Date.now();
      // The first tunnel also creates the relay on Cloudflare, which takes about 20 s.
      await app.progress(`Adding ${label}…`, (e) => e.add({ target: normalized, label }));
      await app.refresh();
      const added = app.statuses.find((t) => t.label === label);
      if (added?.state === 'active') {
        app.log('info', `✓ ${label} is live at ${added.url} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
        const running = await appRunning(added);
        if (!running) app.log('info', `  ${waitingForApp(added)}`);
        const pick = await vscode.window.showInformationMessage(
          addedMessage(added, first, running),
          'Copy URL',
          'Open',
        );
        if (pick === 'Copy URL') await copyUrl(added);
        if (pick === 'Open') await openUrl(added);
      } else if (added?.state === 'failed' && added.error) {
        throw new EverportError(added.error.code as EverportErrorCode, added.error.message, added.error.hint);
      }
    }),
  );

  reg('upAll', () =>
    app.run('Start all', async () => {
      await app.progress('Starting tunnels…', (ep) => ep.up({ all: true }));
      await app.refresh();
      await app.reportStartAll();
    }),
  );

  reg('downAll', () =>
    app.run('Stop all', async () => {
      const outcome = await app.progress('Stopping tunnels…', (ep) => ep.down());
      await app.refresh();
      if (outcome === 'killed') app.log('info', '  The agent did not stop in time and was ended by force');
      app.log('info', `✓ ${DOWN_MESSAGES[outcome]}`);
      void vscode.window.showInformationMessage(DOWN_MESSAGES[outcome]);
    }),
  );

  reg('start', (t: TunnelStatus) =>
    app.run(`Start ${t.label}`, async () => {
      await app.withBusy([t.id], 'Starting…', async () => {
        const ep = await app.ep();
        if (needsUp(await ep.start(t.id))) await ep.up();
      });
      logTunnelResult(app, t.id);
      // Right after Start is when a 502 would be blamed on Everport: say once if the app is not running.
      const now = app.statuses.find((s) => s.id === t.id);
      if (now?.state === 'active' && !(await appRunning(now))) {
        app.log('info', `  ${waitingForApp(now)}`);
        void vscode.window.showInformationMessage(startedWaitingMessage(now));
      }
    }),
  );

  reg('stop', (t: TunnelStatus) =>
    app.run(`Stop ${t.label}`, async () => {
      await app.withBusy([t.id], 'Stopping…', async () => void (await (await app.ep()).stop(t.id)));
      app.log('info', `✓ ${t.label} stopped. Its URL is kept.`);
    }),
  );

  // Retry runs Start All: every tunnel is checked again, so the whole view shows progress.
  reg('retry', (t: TunnelStatus) =>
    app.run(`Retry ${t.label}`, async () => {
      await app.viewProgress(() => app.withBusy([t.id], 'Retrying…', async () => void (await (await app.ep()).up())));
      await app.reportStartAll();
    }),
  );

  reg('remove', (t: TunnelStatus) =>
    app.run(`Remove ${t.label}`, async () => {
      const pick = await vscode.window.showWarningMessage(
        removeQuestion(t),
        { modal: true, detail: removeDetail(t) },
        REMOVE_BUTTON,
      );
      if (!pick) return app.log('info', '  Cancelled');
      try {
        await app.withBusy([t.id], 'Removing…', async () => (await app.ep()).remove(t.id));
      } catch (e) {
        // Cloudflare could not be asked (offline, logged out, Worker gone): offer to forget the tunnel here only.
        if (!(e instanceof EverportError) || ['TUNNEL_NOT_FOUND', 'LOCKED'].includes(e.code)) throw e;
        const { summary } = errorText({ code: e.code, message: e.message, hint: e.hint });
        app.log('warn', `  Cloudflare step failed: ${summary}`);
        const choice = await vscode.window.showWarningMessage(
          removeLocalQuestion(t, summary),
          { modal: true, detail: REMOVE_LOCAL_DETAIL },
          REMOVE_LOCAL_BUTTON,
        );
        if (!choice) throw e;
        await app.withBusy([t.id], 'Removing…', async () => (await app.ep()).remove(t.id, { localOnly: true }));
        app.log('info', `✓ ${t.label} removed from this computer. Its preview may still be on Cloudflare.`);
        return;
      }
      app.log('info', `✓ ${t.label} removed. ${new URL(t.url).host} no longer works.`);
    }),
  );

  reg('checkHealth', (t: TunnelStatus) =>
    app.run(`Check health of ${t.label}`, async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Checking ${t.label}…` },
        () => app.refresh({ health: true }),
      );
      const now = app.statuses.find((s) => s.id === t.id) ?? t;
      const text = healthMessage(now);
      const good = now.health === 'ok'; // an app that is not running is a note, not a problem of the tunnel
      app.log(good || !now.health ? 'info' : 'warn', `${good ? '✓' : '✗'} ${text}`);
      void (now.health && !good ? vscode.window.showWarningMessage(text) : vscode.window.showInformationMessage(text));
    }),
  );

  reg('copyUrl', (t: TunnelStatus) => copyUrl(t));
  reg('openUrl', (t: TunnelStatus) => openUrl(t));

  reg('login', () =>
    app.run('Log in to Cloudflare', async () => {
      // Cloudflare's own tool does the login in the browser; Everport never sees it.
      const ep = await app.ep();
      const done = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: LOGIN_WAIT_TITLE, cancellable: true },
        async (p, token) => {
          p.report({ message: LOGIN_WAIT_TEXT });
          const stop = new AbortController();
          token.onCancellationRequested(() => stop.abort());
          try {
            await ep.login({ signal: stop.signal });
            return true;
          } catch (e) {
            if (e instanceof EverportError && e.code === 'CANCELLED') return false;
            throw e;
          }
        },
      );
      if (!done) return app.log('info', '  Cancelled');
      app.setLoggedIn(true);
      app.log('info', '✓ Logged in to Cloudflare');
      await app.refresh();
      const pick = await vscode.window.showInformationMessage(LOGGED_IN_TEXT, 'Add a Tunnel');
      if (pick === 'Add a Tunnel') await vscode.commands.executeCommand('everport.add');
    }),
  );

  reg('doctor', () =>
    app.run('Run Doctor', async () => {
      const checks = await app.progress('Checking your setup…', (ep) => ep.doctor());
      const { lines, notice } = doctorReport(checks);
      for (const l of lines) app.log(l.level, l.text);
      const ok = checks.every((c) => c.ok);
      const pick = ok
        ? await vscode.window.showInformationMessage(notice)
        : await vscode.window.showWarningMessage(notice, 'Show Details');
      if (pick === 'Show Details') app.showLog();
    }),
  );
}

/** "✓ api online", or the reason it is not. */
function logTunnelResult(app: App, id: string): void {
  const t = app.statuses.find((s) => s.id === id);
  if (!t) return;
  if (t.state === 'active') return app.log('info', `✓ ${t.label} online`);
  if (t.state === 'failed' && t.error) {
    const { summary, fix } = errorText(t.error);
    app.log('error', `✗ ${t.label}: ${summary}`);
    if (fix) app.log('error', `    Fix: ${fix}`);
    return;
  }
  app.log('warn', `${t.label}: ${STATE_WORDS[t.state]}`);
}

/** One TCP connect to the tunnel's local port: does something listen there? */
const appRunning = (t: TunnelStatus): Promise<boolean> => new NodeLocalProbe().listening(t.target).catch(() => true);

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
  const state = {
    candidates: null as PortCandidate[] | null,
    showAll: false,
    typed: '',
    sharedNames: sharedNames(app.statuses),
  };
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
      app.out.warn(`Could not list the running services: ${e instanceof Error ? e.message : String(e)}`);
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
