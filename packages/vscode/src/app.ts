import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createEverport } from '@everport/agent';
import { createLayout, EverportError, type Everport, type TunnelStatus } from '@everport/core';
import { POLL_HIDDEN_MS, POLL_VISIBLE_MS, shouldAutoStart } from './lifecycle.js';
import { findNode } from './node-path.js';
import type { TunnelsProvider } from './tunnels-view.js';
import { failedSummary } from './ui-text.js';
import { badgeCount, statusBar } from './view-model.js';

const probeNode = (command: string, args: string[]) =>
  new Promise<string | undefined>((resolve) =>
    execFile(command, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : stdout)),
  );

const setContext = (key: string, value: boolean) => vscode.commands.executeCommand('setContext', key, value);

/** Shared state of the extension: the manager, the last statuses, busy rows and the UI they drive. */
export class App {
  statuses: TunnelStatus[] = [];
  private readonly busy = new Set<string>();
  private everportPromise: Promise<Everport> | undefined;
  private nodeMissing = false;
  private lastStatusError = '';
  private loginChecking = false;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly provider: TunnelsProvider,
    private readonly view: vscode.TreeView<TunnelStatus>,
    private readonly bar: vscode.StatusBarItem,
    readonly out: vscode.OutputChannel,
    private readonly extensionPath: string,
  ) {}

  /** Built once. The agent and the Worker sit next to extension.js; a real Node runs the agent (not Electron). */
  ep(): Promise<Everport> {
    this.everportPromise ??= this.createManager();
    return this.everportPromise;
  }

  /** Forget the manager (and a "Node not found" result), e.g. after the Node setting changed or on Refresh. */
  resetEverport(): void {
    this.everportPromise = undefined;
  }

  private async createManager(): Promise<Everport> {
    const setting = vscode.workspace.getConfiguration('everport').get<string>('nodePath', '');
    let nodePath: string;
    try {
      nodePath = await findNode(setting, probeNode);
    } catch (e) {
      this.nodeMissing = true;
      throw e;
    }
    this.nodeMissing = false;
    const dist = join(this.extensionPath, 'dist');
    const workerName = process.env['EVERPORT_WORKER_NAME'];
    return createEverport({
      workerFile: join(dist, 'worker.js'),
      agentEntry: join(dist, 'agent.mjs'),
      nodePath,
      ...(workerName ? { workerName } : {}),
    });
  }

  /** One status read at a time: polls, focus and file changes share the read in flight. */
  async refresh(opts: { health?: boolean } = {}): Promise<void> {
    if (this.inFlight && !opts.health) return this.inFlight;
    const run = this.readStatus(opts);
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  /** Bring tunnels up after VS Code starts, only when needed (see shouldAutoStart). */
  async autoStart(): Promise<void> {
    const startOnOpen = vscode.workspace.getConfiguration('everport').get<boolean>('startOnOpen', false);
    if (!startOnOpen) return;
    let ep: Everport;
    try {
      ep = await this.ep();
    } catch {
      return; // the view already explains that Node is missing
    }
    if (!shouldAutoStart(this.statuses, await ep.isLoggedIn(), startOnOpen)) return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Everport: starting tunnels' },
        () => ep.up(),
      );
    } catch (e) {
      this.out.appendLine(`auto start failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refresh();
    const failed = failedSummary(this.statuses);
    if (failed && (await vscode.window.showWarningMessage(failed, 'Show Log')) === 'Show Log') await this.showLog();
  }

  /**
   * Keeps the view current: every 10 s while visible, every 60 s while hidden (status bar), on window focus,
   * and right after tunnels.json changes (another window or the CLI edited it).
   */
  watch(ctx: vscode.ExtensionContext): void {
    let timer: ReturnType<typeof setInterval> | undefined;
    const schedule = () => {
      clearInterval(timer);
      timer = setInterval(() => void this.refresh(), this.view.visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
    };
    schedule();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void this.refresh(), 300);
    };
    const { dataDir } = createLayout({ platform: process.platform, env: process.env, home: homedir() });
    const files = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dataDir), 'tunnels.json'),
    );
    ctx.subscriptions.push(
      this.view.onDidChangeVisibility((e) => {
        schedule();
        if (e.visible) void this.refresh();
      }),
      vscode.window.onDidChangeWindowState((s) => s.focused && void this.refresh()),
      files,
      files.onDidChange(soon),
      files.onDidCreate(soon),
      files.onDidDelete(soon),
      { dispose: () => (clearInterval(timer), clearTimeout(debounce)) },
    );
  }

  private async readStatus(opts: { health?: boolean }): Promise<void> {
    try {
      const ep = await this.ep();
      this.statuses = await ep.status(opts);
      this.lastStatusError = '';
      await setContext('everport.nodeMissing', false);
      void this.checkLogin(ep);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== this.lastStatusError) this.out.appendLine(`status failed: ${message}`);
      this.lastStatusError = message;
      this.statuses = [];
      await setContext('everport.nodeMissing', this.nodeMissing);
    }
    await setContext('everport.ready', true);
    this.render();
  }

  /**
   * Whether to offer "Log in" in the empty view. Asking Cloudflare can take seconds (the first call may even download
   * wrangler), so it never blocks the view, and it is only needed while there are no tunnels.
   */
  private async checkLogin(ep: Everport): Promise<void> {
    if (this.statuses.length > 0 || this.loginChecking) return;
    this.loginChecking = true;
    try {
      this.setLoggedIn(await ep.isLoggedIn());
    } catch (e) {
      this.out.appendLine(`login check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.loginChecking = false;
    }
  }

  setLoggedIn(loggedIn: boolean): void {
    void setContext('everport.loginKnown', true);
    void setContext('everport.loggedIn', loggedIn);
  }

  private render(): void {
    this.provider.setData(this.statuses, this.busy);
    const count = badgeCount(this.statuses);
    this.view.badge = count > 0 ? { value: count, tooltip: `${count} need attention` } : undefined;
    const sb = statusBar(this.statuses);
    this.bar.text = sb.text;
    this.bar.tooltip = sb.tooltip;
    this.bar.backgroundColor = sb.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.bar.show();
  }

  /** Spinner on the given rows while `work` runs, then a fresh status. */
  async withBusy(ids: string[], work: () => Promise<unknown>): Promise<void> {
    ids.forEach((id) => this.busy.add(id));
    this.render();
    try {
      await work();
    } finally {
      ids.forEach((id) => this.busy.delete(id));
      await this.refresh();
    }
  }

  /** Notification with the core's progress events as messages. */
  async progress<T>(title: string, work: (ep: Everport) => Promise<T>): Promise<T> {
    const ep = await this.ep();
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (p) => {
      const off = ep.on('event', (e) => p.report({ message: e.message }));
      try {
        return await work(ep);
      } finally {
        off();
      }
    });
  }

  /** Runs a command and turns any failure into one error message with a way to the log. */
  async run(title: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (e) {
      const known = e instanceof EverportError ? e : undefined;
      if (known?.code === 'NOT_LOGGED_IN') {
        this.out.appendLine(`${title} failed: ${known.message}`);
        const pick = await vscode.window.showWarningMessage(`${title}: you are not logged in to Cloudflare.`, 'Log in');
        if (pick === 'Log in') await vscode.commands.executeCommand('everport.login');
        return;
      }
      const message = known ? `${known.message}${known.hint ? `. ${known.hint}` : ''}` : String(e);
      this.out.appendLine(`${title} failed: ${message}`);
      const pick = await vscode.window.showErrorMessage(`${title}: ${message}`, 'Show Log');
      if (pick === 'Show Log') await this.showLog();
    }
  }

  async showLog(): Promise<void> {
    let file: string;
    try {
      file = (await this.ep()).logFile;
    } catch {
      this.out.show(true); // no manager yet (Node missing): the output channel has the reason
      return;
    }
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), {
        preview: true,
      });
    } catch {
      void vscode.window.showInformationMessage(`No log yet (${file}).`);
    }
  }
}
