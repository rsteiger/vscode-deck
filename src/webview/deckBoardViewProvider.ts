import * as vscode from 'vscode';
import { deckBoardHtml } from './deckBoardHtml';
import type { DeckBoard } from './deckBoardModel';

// Actions the board raises back to the extension.
export interface DeckBoardHandlers {
  openWorktree(worktreePath: string): void;
  openPr(prNumber: number, url: string): void;
  assignSection(worktreePath: string, sectionId: string): void;
  addSection(): void;
  renameSection(sectionId: string): void;
  removeSection(sectionId: string): void;
}

interface BoardMessage {
  type: string;
  path?: string;
  sectionId?: string;
  id?: string;
  number?: number;
  url?: string;
}

// Renders the Deck board as a webview view: SCM-style section headers with count
// badges, worktree rows, and PRs, with drag-and-drop between sections. Data is
// pushed from the extension via buildModel(); user actions come back through the
// injected handlers.
// How often the board re-polls its data while the view is visible. Event-driven
// refreshes (terminal poll, agent status, section edits) still fire immediately;
// this timer catches everything else (PR/status changes with no local event).
const AUTO_REFRESH_MS = 10_000;

export class DeckBoardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deck.board';
  private view: vscode.WebviewView | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly buildModel: () => Promise<DeckBoard>,
    private readonly handlers: DeckBoardHandlers,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = deckBoardHtml(view.webview);
    view.webview.onDidReceiveMessage((message: BoardMessage) => {
      void this.onMessage(message);
    });
    // Poll only while the view is visible; refresh immediately when it (re)shows.
    view.onDidChangeVisibility?.(() => this.syncAutoRefresh());
    view.onDidDispose(() => {
      this.stopAutoRefresh();
      if (this.view === view) this.view = undefined;
    });
    this.syncAutoRefresh();
  }

  private syncAutoRefresh(): void {
    if (this.view?.visible) {
      void this.refresh();
      if (!this.refreshTimer) {
        this.refreshTimer = setInterval(() => {
          if (this.view?.visible) void this.refresh();
        }, AUTO_REFRESH_MS);
      }
    } else {
      this.stopAutoRefresh();
    }
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    let model: DeckBoard;
    try {
      model = await this.buildModel();
    } catch {
      model = { sections: [] }; // Never leave the board blank on a build error.
    }
    void this.view.webview.postMessage({ type: 'model', model });
  }

  private async onMessage(message: BoardMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.refresh();
        return;
      case 'openWorktree':
        if (message.path) this.handlers.openWorktree(message.path);
        return;
      case 'openPr':
        if (typeof message.number === 'number' && message.url) {
          this.handlers.openPr(message.number, message.url);
        }
        return;
      case 'assign':
        if (message.path !== undefined && message.sectionId !== undefined) {
          this.handlers.assignSection(message.path, message.sectionId);
        }
        return;
      case 'renameSection':
        if (message.id) this.handlers.renameSection(message.id);
        return;
      case 'removeSection':
        if (message.id) this.handlers.removeSection(message.id);
        return;
      default:
        return;
    }
  }
}
