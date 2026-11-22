import * as vscode from 'vscode';
import { App } from './app.js';
import { registerCommands } from './commands.js';
import { TunnelsProvider } from './tunnels-view.js';

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Everport');
  const provider = new TunnelsProvider();
  const view = vscode.window.createTreeView('everport.tunnels', { treeDataProvider: provider });
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.command = 'workbench.view.extension.everport';
  ctx.subscriptions.push(out, view, bar);

  const app = new App(provider, view, bar, out, ctx.extensionPath);
  registerCommands(ctx, app);
  app.watch(ctx);
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('everport.nodePath')) return;
      app.resetEverport();
      void app.refresh();
    }),
  );
  // In the background: activation must not wait for Cloudflare or for a first wrangler download.
  void app.refresh().then(() => app.autoStart());
}

export function deactivate(): void {}
