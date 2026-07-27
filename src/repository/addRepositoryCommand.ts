import * as vscode from 'vscode';
import {
  CommonDirCacheLike,
  PASS_THROUGH_COMMON_DIR_CACHE,
} from './repositoryCommonDirCache';
import {
  ActiveWorktreeStoreLike,
  DetachedOpenerLike,
  registerRepositorySeed,
  RepositoryRegistryLike,
  showRepositoryPostAddPrompt,
  SwitcherLike,
} from './registerRepositorySeed';

export interface RepositoryFolderPicker {
  pick(): Promise<string | undefined>;
}

export class VsCodeRepositoryFolderPicker implements RepositoryFolderPicker {
  async pick(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Add as Deck repository',
    });
    return picked?.[0]?.fsPath;
  }
}

/**
 * Picks a repository from the open workspace folders via a Quick Pick,
 * falling back to the file dialog via "Browse…".
 *
 * The file dialog is awkward in VS Code web (code-server), where the common
 * case is registering the folder already open — this offers those folders as
 * a one-click list.
 */
export class WorkspaceFolderRepositoryPicker implements RepositoryFolderPicker {
  constructor(private readonly fallback: RepositoryFolderPicker) {}

  async pick(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return this.fallback.pick();
    const browse = 'Browse for a folder…';
    const items = [...folders.map((f) => f.uri.fsPath), browse];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Folder to add as a Deck repository',
    });
    if (picked === undefined) return undefined;
    return picked === browse ? this.fallback.pick() : picked;
  }
}

export class AddRepositoryCommand {
  constructor(
    private readonly picker: RepositoryFolderPicker,
    private readonly registry: RepositoryRegistryLike,
    private readonly activeWorktrees: ActiveWorktreeStoreLike,
    private readonly switcher: SwitcherLike,
    private readonly detachedOpener: DetachedOpenerLike,
    private readonly refresh: () => void,
    private readonly reveal: (repositoryPath: string) => Promise<void>,
    private readonly repositoryCommonDirCache: CommonDirCacheLike = PASS_THROUGH_COMMON_DIR_CACHE,
  ) {}

  async run(): Promise<void> {
    const seedPath = await this.picker.pick();
    if (!seedPath) return;

    const result = await registerRepositorySeed({
      seedPath,
      registry: this.registry,
      activeWorktrees: this.activeWorktrees,
      refresh: this.refresh,
      reveal: this.reveal,
      repositoryCommonDirCache: this.repositoryCommonDirCache,
    });
    if (result.kind === 'notGit') return;

    // An already-registered pick still reveals the existing Repository and
    // offers the post-add actions — the drag path treats a duplicate as a
    // no-op, but the explicit menu command should never feel like a dead click.
    if (result.kind === 'duplicate') {
      await this.activeWorktrees.set(result.commonDir, seedPath);
      this.refresh();
      await this.reveal(seedPath);
    }

    await showRepositoryPostAddPrompt(seedPath, this.switcher, this.detachedOpener);
  }
}
