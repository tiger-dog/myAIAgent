import * as vscode from "vscode";
import type { RuntimeClient, ThreadSummary } from "./runtimeClient";

export class ThreadTreeItem extends vscode.TreeItem {
  constructor(
    public readonly summary: ThreadSummary,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    const label =
      summary.title.length > 48 ? summary.title.slice(0, 45) + "…" : summary.title;
    super(label, collapsibleState);
    this.description = summary.archived ? "[归档]" : summary.mode;
    this.tooltip = new vscode.MarkdownString(
      `**${summary.title}**\n\n\`${summary.id}\`\n\n${summary.preview}`
    );
    this.contextValue = "deepseekThread";
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
    this.command = {
      command: "deepseek.openThread",
      title: "打开",
      arguments: [summary.id],
    };
  }
}

export class InfoTreeItem extends vscode.TreeItem {
  constructor(label: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export type ThreadTreeNode = ThreadTreeItem | InfoTreeItem;

export class ThreadTreeProvider implements vscode.TreeDataProvider<ThreadTreeNode> {
  private _onDidChange = new vscode.EventEmitter<ThreadTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private summaries: ThreadSummary[] = [];
  private loadError: string | null = null;
  private searchQuery: string | undefined;

  constructor(private readonly client: RuntimeClient) {}

  setSearch(query: string | undefined): void {
    this.searchQuery = query?.trim() || undefined;
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  async loadFromApi(): Promise<void> {
    this.loadError = null;
    const includeArchived = vscode.workspace
      .getConfiguration("deepseek.sidebar")
      .get<boolean>("includeArchived", false);
    try {
      const ok = await this.client.health();
      if (!ok) {
        this.loadError =
          "无法连接 /health。请确认已安装 deepseek CLI；可开启设置 deepseek.runtime.autoStartRuntime 以自动启动，或手动运行 deepseek serve --http";
        this.summaries = [];
        this.refresh();
        return;
      }
      this.summaries = await this.client.listThreadsSummary({
        limit: 200,
        includeArchived,
        search: this.searchQuery,
      });
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e);
      this.summaries = [];
    }
    this.refresh();
  }

  getTreeItem(element: ThreadTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ThreadTreeNode): Thenable<ThreadTreeNode[]> {
    if (element) {
      return Promise.resolve([]);
    }
    if (this.loadError) {
      return Promise.resolve([new InfoTreeItem(this.loadError, "error")]);
    }
    if (this.summaries.length === 0) {
      return Promise.resolve([new InfoTreeItem("无会话 — 使用「新建会话」", "info")]);
    }
    return Promise.resolve(
      this.summaries.map(
        (s) => new ThreadTreeItem(s, vscode.TreeItemCollapsibleState.None)
      )
    );
  }
}
