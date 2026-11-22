import * as vscode from 'vscode';
import type { TunnelStatus } from '@everport/core';
import { toItem } from './view-model.js';

export class TunnelsProvider implements vscode.TreeDataProvider<TunnelStatus> {
  private data: TunnelStatus[] = [];
  private busy = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  setData(ts: TunnelStatus[], busyIds: Iterable<string> = []): void {
    this.data = ts;
    this.busy = new Set(busyIds);
    this.changed.fire();
  }

  getTreeItem(t: TunnelStatus): vscode.TreeItem {
    const m = toItem(t, this.busy.has(t.id));
    const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.None);
    item.id = m.id;
    item.description = m.description;
    item.iconPath = new vscode.ThemeIcon(m.icon.id, m.icon.color ? new vscode.ThemeColor(m.icon.color) : undefined);
    const tip = new vscode.MarkdownString(m.tooltip, true);
    tip.supportThemeIcons = true;
    item.tooltip = tip;
    item.contextValue = m.contextValue;
    return item;
  }

  getChildren(parent?: TunnelStatus): TunnelStatus[] {
    return parent ? [] : this.data;
  }
}
