import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createEverport } from '@everport/agent';
import { createLayout, EverportError, MIN_NODE_LABEL, type Everport, type TunnelStatus } from '@everport/core';
import { POLL_HIDDEN_MS, POLL_VISIBLE_MS, shouldAutoStart } from './lifecycle.js';
import { discoverNodes, type DiscoveryHost, type NodeCandidate } from './node-discovery.js';
import {
  NodeUnusableError,
  PROBE_ARGS,
  detectedNote,
  findNodeInfo,
  nodePickEntries,
  nodeProblemText,
  parseProbe,
  pickedNodeText,
  type NodeInfo,
  type NodePickEntry,
} from './node-path.js';
import type { TunnelsProvider } from './tunnels-view.js';
import { cliToVsCode, errorText, failedNotice, progressText, startAllSummary, type LogLevel } from './ui-text.js';
import { badgeCount, statusBar, viewMessage, type BusyVerb } from './view-model.js';

const probeNode = (command: string, args: string[]) =>
  new Promise<string | undefined>((resolve) =>
    execFile(command, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : stdout)),
  );

const discoveryHost: DiscoveryHost = {
  platform: process.platform,
  env: process.env,
  home: homedir(),
  subfolders: async (dir) => {
    try {
      return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  },
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
};

const probeCandidate = async (path: string): Promise<NodeCandidate | undefined> => {
  const found = parseProbe(await probeNode(path, PROBE_ARGS));
  return found ? { path: found.path, version: found.version } : undefined;
};

/** Node.js installs in the folders of the version managers and the usual system places, newest first. */
const discover = () => discoverNodes(discoveryHost, probeCandidate);

const setContext = (key: string, value: boolean) => vscode.commands.executeCommand('setContext', key, value);

export const VIEW_ID = 'everport.tunnels';

/** Shared state of the extension: the manager, the last statuses, busy rows and the UI they drive. */
export class App {
  statuses: TunnelStatus[] = [];
  private readonly busy = new Map<string, BusyVerb>();
  private everportPromise: Promise<Everport> | undefined;
  private ready = false;
  private nodeMissing = false;
  /** Why Node.js cannot be used, in one sentence above the empty view. */
  private nodeProblem = '';
  /** The Node.js the manager runs on, once found. */
  private currentNode: NodeInfo | undefined;
  private lastStatusError = '';
  /** tunnels.json (or the agent) could not be read, for a reason other than Node. */
  private statusError = false;
  private loginKnown = false;
  private loggedIn = false;
  private loginError = false;
  private lastLoginError = '';
  private loginChecking = false;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly provider: TunnelsProvider,
    private readonly view: vscode.TreeView<TunnelStatus>,
    private readonly bar: vscode.StatusBarItem,
    readonly out: vscode.LogOutputChannel,
    private readonly extensionPath: string,
  ) {
    this.render();
    const { agentLogFile } = createLayout({ platform: process.platform, env: process.env, home: homedir() });
    out.info(`Background agent log: ${agentLogFile}`);
  }

  /** Built once. The agent and the Worker sit next to extension.js; a real Node runs the agent (not Electron). */
  ep(): Promise<Everport> {
    this.everportPromise ??= this.createManager();
    return this.everportPromise;
  }

  /** "Everport: Select Node.js": the installs found on this computer, a file to browse to, or the automatic choice. */
  async selectNode(): Promise<void> {
    type Item = vscode.QuickPickItem & { entry?: NodePickEntry };
    const [found, pathNode] = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Looking for Node.js…' },
      () => Promise.all([discover(), probeCandidate('node')]),
    );
    const items: Item[] = nodePickEntries(found, this.currentNode?.path, pathNode).map((entry) =>
      entry.kind === 'separator'
        ? { label: entry.label, kind: vscode.QuickPickItemKind.Separator }
        : {
            label: entry.label,
            ...('description' in entry ? { description: entry.description } : {}),
            ...('detail' in entry ? { detail: entry.detail } : {}),
            entry,
          },
    );
    const picked = (
      await vscode.window.showQuickPick(items, {
        title: 'Everport: Select Node.js',
        placeHolder:
          found.length > 0 ? 'Pick the Node.js Everport should use' : `No Node.js ${MIN_NODE_LABEL} or newer found`,
      })
    )?.entry;
    if (!picked || picked.kind === 'separator') return;
    const config = vscode.workspace.getConfiguration('everport');
    if (picked.kind === 'auto') {
      await config.update('nodePath', '', vscode.ConfigurationTarget.Global); // the change handler re-reads everything
      this.out.info('Node.js: picked automatically from now on');
      void vscode.window.showInformationMessage('Everport will pick Node.js automatically.');
      return;
    }
    let path = picked.kind === 'use' ? picked.path : undefined;
    if (picked.kind === 'browse') {
      const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Select the node executable' });
      path = chosen?.[0]?.fsPath;
    }
    if (!path) return;
    let info: NodeInfo;
    try {
      info = await findNodeInfo(path, probeNode);
    } catch (e) {
      const text = e instanceof NodeUnusableError ? pickedNodeText(e) : String(e);
      this.out.warn(`Node.js not changed: ${e instanceof Error ? e.message : String(e)}`);
      if ((await vscode.window.showErrorMessage(text, 'Choose Again')) === 'Choose Again') await this.selectNode();
      return;
    }
    await config.update('nodePath', path, vscode.ConfigurationTarget.Global); // the change handler re-reads everything
    this.out.info(`Node.js: now ${info.version} (${info.path})`);
    void vscode.window.showInformationMessage(`Everport now uses Node.js ${info.version}.`);
  }

  /** Forget the manager (and a "Node not found" result), e.g. after the Node setting changed or on Refresh. */
  resetEverport(): void {
    this.everportPromise = undefined;
  }

  private async createManager(): Promise<Everport> {
    const setting = vscode.workspace.getConfiguration('everport').get<string>('nodePath', '');
    let node: NodeInfo;
    try {
      node = await findNodeInfo(setting, probeNode, discover);
    } catch (e) {
      this.nodeMissing = true;
      this.nodeProblem = e instanceof NodeUnusableError ? nodeProblemText(e) : String(e);
      this.currentNode = undefined;
      throw e;
    }
    this.nodeMissing = false;
    this.nodeProblem = '';
    this.currentNode = node;
    if (node.source === 'detected') this.out.info(detectedNote(node));
    const dist = join(this.extensionPath, 'dist');
    const workerName = process.env['EVERPORT_WORKER_NAME'];
    return createEverport({
      workerFile: join(dist, 'worker.js'),
      agentEntry: join(dist, 'agent.mjs'),
      nodePath: node.path,
      nodeVersion: node.version,
      ...(workerName ? { workerName } : {}),
    });
  }

  /** The Worker name new tunnels go to, for the URL preview. */
  get workerName(): string {
    return process.env['EVERPORT_WORKER_NAME'] || 'everport';
  }

  /** Progress bar under the view's title while `work` runs. */
  viewProgress<T>(work: () => Thenable<T>): Thenable<T> {
    return vscode.window.withProgress({ location: { viewId: VIEW_ID } }, work);
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
    this.log('info', '▶ Start all (VS Code opened)');
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Everport: starting tunnels' },
        () => ep.up(),
      );
    } catch (e) {
      this.logError('Start all', e);
    }
    await this.refresh();
    await this.reportStartAll();
  }

  /** Log line and notification after Start All (or Retry, which runs it too). */
  async reportStartAll(): Promise<void> {
    const summary = startAllSummary(this.statuses);
    this.log(summary.ok ? 'info' : 'warn', summary.text);
    const notice = failedNotice(this.statuses);
    if (!notice) return;
    const actions = notice.retry ? ['Retry', 'Show Log'] : ['Show Log'];
    const pick = await vscode.window.showWarningMessage(notice.text, ...actions);
    if (pick === 'Retry' && notice.retry) await vscode.commands.executeCommand('everport.retry', notice.retry);
    if (pick === 'Show Log') this.showLog();
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
      // The first read also finds Node.js, which can take seconds: show it.
      const ep = this.everportPromise ? await this.ep() : await this.viewProgress(() => this.ep());
      this.statuses = await ep.status(opts);
      this.lastStatusError = '';
      this.statusError = false;
      void this.checkLogin(ep);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== this.lastStatusError) {
        this.out.error(this.nodeMissing ? `✗ ${this.nodeProblem}` : `✗ Could not read your tunnels: ${message}`);
        if (this.nodeMissing) this.out.info(`    ${message}`);
        if (e instanceof EverportError && e.hint) this.out.info(`    Fix: ${cliToVsCode(e.hint)}`);
      }
      this.lastStatusError = message;
      this.statusError = !this.nodeMissing;
      this.statuses = [];
    }
    this.ready = true;
    this.updateContexts();
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
      const ask = () => ep.isLoggedIn();
      this.setLoggedIn(this.loginKnown ? await ask() : await this.viewProgress(ask));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== this.lastLoginError) {
        this.out.warn("Couldn't check the Cloudflare login. Check your connection, then click Try Again.");
        this.out.debug(`  ${message}`);
      }
      this.lastLoginError = message;
      if (!this.loginKnown) {
        this.loginError = true;
        this.updateContexts();
        this.render();
      }
    } finally {
      this.loginChecking = false;
    }
  }

  setLoggedIn(loggedIn: boolean): void {
    this.loginKnown = true;
    this.loggedIn = loggedIn;
    this.loginError = false;
    this.lastLoginError = '';
    this.updateContexts();
    this.render();
  }

  private updateContexts(): void {
    const hasTunnels = this.statuses.length > 0;
    const usable = this.ready && !this.nodeMissing;
    void setContext('everport.ready', this.ready);
    void setContext('everport.nodeMissing', this.nodeMissing);
    void setContext('everport.statusError', this.statusError);
    void setContext('everport.loginKnown', this.loginKnown);
    void setContext('everport.loggedIn', this.loggedIn);
    void setContext('everport.loginError', this.loginError);
    void setContext('everport.hasTunnels', hasTunnels);
    void setContext(
      'everport.anyRunning',
      this.statuses.some((t) => t.state === 'active' || t.state === 'failed'),
    );
    // Tunnels on disk prove a login once happened, so their actions stay while the login is not checked.
    void setContext('everport.canManage', usable && (hasTunnels || this.loggedIn));
  }

  private render(): void {
    this.provider.setData(this.statuses, this.busy);
    this.view.message = this.nodeMissing && this.nodeProblem ? this.nodeProblem : viewMessage(this.statuses);
    const count = badgeCount(this.statuses);
    this.view.badge = count > 0 ? { value: count, tooltip: `${count} need attention` } : undefined;
    const checking =
      !this.ready ||
      (!this.nodeMissing && !this.statusError && this.statuses.length === 0 && !this.loginKnown && !this.loginError);
    const sb = statusBar(this.statuses, {
      checking,
      nodeMissing: this.nodeMissing,
      loggedOut: this.loginKnown && !this.loggedIn,
    });
    this.bar.text = sb.text;
    this.bar.tooltip = sb.tooltip;
    this.bar.backgroundColor = sb.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.bar.show();
  }

  /** Spinner and `verb` ("Starting…") on the given rows while `work` runs, then a fresh status. */
  async withBusy(ids: string[], verb: BusyVerb, work: () => Promise<unknown>): Promise<void> {
    ids.forEach((id) => this.busy.set(id, verb));
    this.render();
    try {
      await work();
    } finally {
      ids.forEach((id) => this.busy.delete(id));
      await this.refresh();
    }
  }

  /** Notification with the core's progress events as messages; each event is also a step in the log. */
  async progress<T>(title: string, work: (ep: Everport) => Promise<T>): Promise<T> {
    const ep = await this.ep();
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (p) => {
      let first = false;
      const off = ep.on('event', (e) => {
        if (e.type === 'relay:setup') first = true;
        const text = progressText(e, first);
        if (!text) return;
        p.report({ message: text });
        this.log('info', `  … ${text}`);
      });
      try {
        return await work(ep);
      } finally {
        off();
      }
    });
  }

  log(level: LogLevel, text: string): void {
    this.out[level](text);
  }

  /** "✗ <title> failed: <summary>", the fix, and the raw cause at debug level. Returns the user-facing text. */
  private logError(title: string, e: unknown): string {
    const known = e instanceof EverportError ? e : undefined;
    const { summary, fix } = known
      ? errorText({ code: known.code, message: known.message, hint: known.hint })
      : { summary: e instanceof Error ? e.message : String(e), fix: '' };
    this.out.error(`✗ ${title} failed: ${summary}`);
    if (fix) this.out.error(`    Fix: ${fix}`);
    if (known) this.out.debug(`    ${known.message}${known.hint ? `. ${known.hint}` : ''} (${known.code})`);
    else if (e instanceof Error && e.stack) this.out.debug(e.stack);
    return `${summary}${fix ? ` ${fix}` : ''}`;
  }

  /** Runs a command as one block in the log and turns any failure into one error message with a way to the log. */
  async run(title: string, work: () => Promise<void>): Promise<void> {
    this.out.info(`▶ ${title}`);
    try {
      await work();
    } catch (e) {
      const text = this.logError(title, e);
      if (e instanceof EverportError && e.code === 'NOT_LOGGED_IN') {
        const pick = await vscode.window.showWarningMessage(`${title}: you're not logged in to Cloudflare.`, 'Log in');
        if (pick === 'Log in') await vscode.commands.executeCommand('everport.login');
        return;
      }
      const pick = await vscode.window.showErrorMessage(`${title} failed. ${text}`, 'Show Log');
      if (pick === 'Show Log') this.showLog();
    }
  }

  showLog(): void {
    this.out.show(true);
  }
}
