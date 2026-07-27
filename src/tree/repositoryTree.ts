import * as path from 'node:path';
import * as vscode from 'vscode';
import { getCommonDir, listWorktrees, Worktree } from '../git/worktrees';
import { RepositoryCommonDirCache, resolveCommonDirSafe } from '../repository/repositoryCommonDirCache';
import { RepositoryRegistryStore } from '../repository/repositoryRegistryStore';
import { ActiveWorktreeStore } from '../switch/activeWorktreeStore';
import { WorktreeListCacheStore } from '../worktree/worktreeListCacheStore';
import { WorktreeOrderStore } from '../worktree/worktreeOrderStore';
import { terminalSessionPrefix } from '../terminal/tmuxSafe';
import { resolveTerminalTooltip } from '../terminal/terminalLabelResolver';
import { TerminalOrderStore } from '../terminal/terminalOrderStore';
import type { TmuxSession } from '../terminal/tmuxCli';
import {
  type CachedTerminalSession,
  toCachedTerminalSessions,
} from '../terminal/terminalSession';
import type { AgentStatus } from '../agent/agentStatusStore';
import {
  agentStatusDecorationResourceUri,
  AgentStatusDecorationRollups,
  type AgentStatusDecorationNodeKind,
  type AgentStatusDecorationResourceUri,
  type AgentStatusDecorationTerminal,
} from '../agent/agentStatusDecorations';
import { excludeBare } from './excludeBare';
import { excludePending } from './excludePending';
import { reconcileWorktreeOrder } from './reconcileWorktreeOrder';
import { reconcileTerminalOrder } from './reconcileTerminalOrder';
import { pruneOrder } from './pruneOrder';
import {
  describeRepositoryTreeItem,
  describeTmuxUnavailableTreeItem,
  describeTerminalTreeItem,
  describeWorktreeTreeItem,
} from './worktreeTreeItem';

export type RepositoryTreeNode =
  | RepositoryNode
  | WorktreeNode
  | TerminalNode
  | TmuxUnavailableNode
  | PrNode
  | PrPlaceholderNode;

const resourcesDir = path.join(__dirname, '..', '..', 'resources');

// The terminal row's left icon carries agent identity, not status (status is
// the right-side decoration). The Claude marks ship as raster assets because
// VS Code currently renders custom tree SVGs black (microsoft/vscode#311339)
// and animated GIFs are the only sanctioned way to animate a custom tree icon.
// Do NOT swap the working GIF for a `loading~spin` codicon to chase reduce-motion:
// the codicon spin keyframe has no prefers-reduced-motion guard and ignores
// `workbench.reduceMotion` too, so it buys no a11y and loses the brand. No
// extension-side option makes an animated tree icon reduce-motion-aware. See ADR-0025 §6.
const terminalTreeIcon = {
  resourcesDir,
  factory: {
    uriFile: vscode.Uri.file,
    themeIcon: (id: string) => new vscode.ThemeIcon(id),
  },
};

interface TerminalSessionLister {
  listSessions(prefix?: string): Promise<TmuxSession[]>;
}

interface AgentStatusLookup {
  get(sessionName: string): AgentStatus | undefined;
  entries(): IterableIterator<[string, AgentStatus]>;
  onDidChange(listener: () => void): { dispose(): void };
}

// Stable TreeItem.id values let VS Code persist expand/collapse + selection
// across reloads (it stores state per id under workbench.tree.<viewId>).

class RepositoryNode extends vscode.TreeItem {
  constructor(
    public readonly repositoryPath: string,
    isActiveRepository: boolean,
  ) {
    const item = describeRepositoryTreeItem(repositoryPath, isActiveRepository);
    super(item.label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `repository::${repositoryPath}`;
    this.contextValue = 'deck.repository';
    this.description = item.description;
    this.tooltip = repositoryPath;
    this.resourceUri = toDecorationUri('repository', repositoryPath);
  }
}

class WorktreeNode extends vscode.TreeItem {
  constructor(
    public readonly repositoryPath: string,
    public readonly worktree: Worktree,
    isActiveWorktree: boolean,
    public readonly mainWorktreePath: string | undefined,
    sessionName?: string,
    revealTerminalOnClick = false,
  ) {
    const item = describeWorktreeTreeItem(
      worktree,
      isActiveWorktree,
      mainWorktreePath,
      sessionName,
    );
    super(item.label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `worktree::${worktree.path}`;
    this.contextValue = item.contextValue;
    this.description = item.description;
    this.tooltip = item.tooltip;
    this.resourceUri = toDecorationUri('worktree', worktree.path);
    // In PR-children mode the row's single click opens the worktree's session
    // terminal; the twistie still expands the PR list underneath.
    if (revealTerminalOnClick) {
      this.command = {
        command: 'deck.revealWorktreeTerminal',
        title: 'Open session terminal',
        arguments: [worktree.path],
      };
    }
  }
}

class TerminalNode extends vscode.TreeItem {
  private renderSignature = '';

  constructor(
    public terminal: TmuxSession,
    public worktreeNode: WorktreeNode,
    isActiveWorktree: boolean,
    status?: AgentStatus,
  ) {
    super('', vscode.TreeItemCollapsibleState.None);
    this.id = `terminal::${terminal.sessionName}`;
    this.resourceUri = toDecorationUri('terminal', terminal.sessionName);
    this.command = {
      command: 'deck.openTerminal',
      title: 'Open Terminal',
      arguments: [this],
    };
    this.update(terminal, worktreeNode, isActiveWorktree, status);
  }

  update(
    terminal: TmuxSession,
    worktreeNode: WorktreeNode,
    isActiveWorktree: boolean,
    status?: AgentStatus,
  ): boolean {
    const item = describeTerminalTreeItem(
      terminal.windowName,
      isActiveWorktree,
      status,
      terminal.paneTitle,
      terminal.agentName,
      terminalTreeIcon,
    );
    const tooltip = resolveTerminalTooltip(this.worktreePath, terminal.sessionName);
    const nextSignature = JSON.stringify([item.label, item.contextValue, item.iconId, tooltip]);
    const changed = this.renderSignature !== '' && this.renderSignature !== nextSignature;

    this.terminal = terminal;
    this.worktreeNode = worktreeNode;
    this.label = item.label;
    this.contextValue = item.contextValue;
    this.description = item.description;
    this.tooltip = tooltip;
    this.iconPath = item.iconPath;
    this.renderSignature = nextSignature;
    return changed;
  }

  get repositoryPath(): string {
    return this.worktreeNode.repositoryPath;
  }

  get worktreePath(): string {
    return this.worktreeNode.worktree.path;
  }
}

export interface WorktreePr {
  number: number;
  title: string;
  url: string;
  needs?: string;
}

class PrNode extends vscode.TreeItem {
  constructor(public readonly pr: WorktreePr) {
    super(`#${pr.number} ${pr.title}`, vscode.TreeItemCollapsibleState.None);
    this.id = `pr::${pr.number}`;
    this.description = pr.needs ?? '';
    this.tooltip = `#${pr.number} ${pr.title}\n${pr.url}`;
    this.iconPath = new vscode.ThemeIcon('git-pull-request');
    this.contextValue = 'deck.pr';
    this.command = {
      command: 'deck.openPr',
      title: 'Open PR',
      arguments: [pr.number, pr.url],
    };
  }
}

class PrPlaceholderNode extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'deck.pr.placeholder';
  }
}

class TmuxUnavailableNode extends vscode.TreeItem {
  constructor(public readonly worktreeNode: WorktreeNode) {
    const item = describeTmuxUnavailableTreeItem();
    super(item.label, vscode.TreeItemCollapsibleState.None);
    this.id = `tmux-unavailable::${worktreeNode.worktree.path}`;
    this.contextValue = item.contextValue;
    this.tooltip = item.tooltip;
    this.iconPath = new vscode.ThemeIcon(item.iconId);
  }
}

export class RepositoryTreeProvider implements vscode.TreeDataProvider<RepositoryTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RepositoryTreeNode | undefined>();
  private readonly _onDidChangeDeckDecorations = new vscode.EventEmitter<AgentStatusDecorationResourceUri[]>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  readonly onDidChangeDeckDecorations = this._onDidChangeDeckDecorations.event;
  readonly agentStatusDecorationRollups = new AgentStatusDecorationRollups();
  private activeRepositoryCommonDir: string | null = null;
  private activeWorktreePath: string | undefined = this.currentWorktreePath();
  private resolvingActiveRepository = false;
  private readonly repositoryCommonDirs = new Map<string, string | null>();
  private readonly resolvingRepositoryPaths = new Set<string>();
  private readonly refreshingWorktrees = new Set<string>();
  private readonly knownWorktreeRepositories = new Map<string, string>();
  private readonly knownTerminals = new Map<string, AgentStatusDecorationTerminal>();
  private readonly renderedTerminals = new Map<string, TerminalNode>();
  private readonly tmux: TerminalSessionLister;
  private readonly tmuxAvailable: boolean;
  // When true, worktrees with no live Deck terminal are hidden (the current
  // worktree and the main worktree always stay visible). Live session names
  // are fed from the terminal poll via setLiveSessionNames.
  hideInactiveWorktrees = false;
  private liveSessionNames: ReadonlySet<string> = new Set();
  // Resolves a worktree path to its Claude session name for the row label
  // (one session per worktree). Unset → label falls back to branch/basename.
  resolveWorktreeSessionName?: (worktreePath: string) => string | undefined;
  // When set, worktree rows list their open PRs as children (and open their
  // session terminal on row click) instead of listing terminal children.
  resolveWorktreePrs?: (worktree: Worktree) => Promise<WorktreePr[]>;
  // When true, drop the repository top-level node and render worktrees at the
  // root (single-project layout).
  flattenRepositories = false;

  constructor(
    private readonly repositoryRegistry: Pick<RepositoryRegistryStore, 'list'>,
    private readonly activeWorktrees: ActiveWorktreeStore,
    private readonly worktreeOrders: WorktreeOrderStore,
    private readonly worktreeListCache: Pick<WorktreeListCacheStore, 'get' | 'set'> = {
      get: () => undefined,
      set: async () => undefined,
    },
    private readonly repositoryCommonDirCache: Pick<RepositoryCommonDirCache, 'get' | 'set'> = {
      get: () => undefined,
      set: async () => undefined,
    },
    tmuxOrAvailable: TerminalSessionLister | boolean = true,
    tmuxAvailable?: boolean,
    private readonly pendingWorktreeRemovals: ReadonlySet<string> = new Set(),
    private readonly agentStatuses?: AgentStatusLookup,
    private readonly terminalOrders?: Pick<TerminalOrderStore, 'get' | 'set'>,
    private readonly ensureSnapshotRestored: () => Promise<void> = () => Promise.resolve(),
  ) {
    this.syncAgentStatusDecorations();
    this.agentStatuses?.onDidChange(() => {
      this.syncAgentStatusDecorations();
      this.refreshRenderedTerminals();
    });

    if (typeof tmuxOrAvailable === 'boolean') {
      this.tmux = { listSessions: async () => [] };
      this.tmuxAvailable = tmuxAvailable ?? tmuxOrAvailable;
      return;
    }

    this.tmux = tmuxOrAvailable;
    this.tmuxAvailable = tmuxAvailable ?? true;
  }

  refresh(): void {
    this.fireDeckDecorations(this.updateActiveWorktreeDecorationTarget());
    this.resolveActiveRepository();
    this._onDidChangeTreeData.fire(undefined);
  }

  refreshTerminalDisplays(sessions: readonly TmuxSession[]): void {
    for (const session of sessions) {
      const node = this.renderedTerminals.get(session.sessionName);
      if (!node) continue;
      this.refreshTerminalDisplay(node, session);
    }
  }

  private refreshRenderedTerminals(): void {
    for (const node of this.renderedTerminals.values()) {
      this.refreshTerminalDisplay(node, node.terminal);
    }
  }

  private refreshTerminalDisplay(node: TerminalNode, terminal: TmuxSession): void {
    if (!node.update(
      terminal,
      node.worktreeNode,
      this.isCurrentWorktree(node.worktreePath),
      this.agentStatuses?.get(terminal.sessionName),
    )) return;

    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(element: RepositoryTreeNode): vscode.TreeItem {
    return element;
  }

  isActiveRepositoryDecorationTarget(repositoryPath: string): boolean {
    return this.isActiveRepository(repositoryPath);
  }

  isActiveWorktreeDecorationTarget(worktreePath: string): boolean {
    return this.isCurrentWorktree(worktreePath);
  }

  setCollapsed(element: RepositoryTreeNode, collapsed: boolean): AgentStatusDecorationResourceUri[] {
    if (element instanceof RepositoryNode) {
      const uris = this.agentStatusDecorationRollups.invalidationUrisForCollapsedNode(
        'repository',
        element.repositoryPath,
      );
      this.agentStatusDecorationRollups.setCollapsed('repository', element.repositoryPath, collapsed);
      return uris;
    }
    if (element instanceof WorktreeNode) {
      const uris = this.agentStatusDecorationRollups.invalidationUrisForCollapsedNode('worktree', element.worktree.path);
      this.agentStatusDecorationRollups.setCollapsed('worktree', element.worktree.path, collapsed);
      return uris;
    }
    return [];
  }

  getParent(element: RepositoryTreeNode): RepositoryTreeNode | undefined {
    if (element instanceof WorktreeNode) {
      if (this.flattenRepositories) return undefined;
      return new RepositoryNode(
        element.repositoryPath,
        this.isActiveRepository(element.repositoryPath),
      );
    }
    if (element instanceof TerminalNode) {
      return this.toParentWorktreeNode(element.worktreeNode);
    }
    if (element instanceof TmuxUnavailableNode) {
      return this.toParentWorktreeNode(element.worktreeNode);
    }
    return undefined;
  }

  getChildren(element?: RepositoryTreeNode): vscode.ProviderResult<RepositoryTreeNode[]> {
    if (!element) {
      // Sync return: any `await` here would yield to the event loop and let
      // viewsWelcome ("No repositories yet") flash on every tree.refresh().
      const repositories = this.repositoryRegistry.list();
      this.resolveActiveRepository();
      const nodes = repositories.map((p) => {
        this.resolveRepositoryCommonDir(p);
        this.syncCachedDecorationWorktrees(p);
        return new RepositoryNode(p, this.isActiveRepository(p));
      });
      this.syncAgentStatusDecorations();
      // Flattened mode: no repository top-level node — worktrees render at the
      // root (single project). getWorktreeChildren returns synchronously from
      // the worktree cache when warm, so the welcome view does not flash.
      if (this.flattenRepositories) {
        if (nodes.length === 1) return this.getWorktreeChildren(nodes[0]);
        return Promise.all(nodes.map((node) => this.resolveChildren(node))).then(
          (lists) => lists.flat(),
        );
      }
      return nodes;
    }
    if (element instanceof RepositoryNode) {
      return this.getWorktreeChildren(element);
    }
    if (element instanceof WorktreeNode) {
      // PR-children mode: the worktree row opens its session terminal on click
      // (see WorktreeNode) and lists the worktree's open PRs underneath.
      if (this.resolveWorktreePrs) return this.getPrChildren(element);
      if (!this.tmuxAvailable) return [new TmuxUnavailableNode(element)];
      return this.getTerminalChildren(element);
    }
    return [];
  }

  async findTerminal(
    sessionName: string,
    worktreePath: string,
  ): Promise<RepositoryTreeNode | undefined> {
    return this.findTerminalNode(
      sessionName,
      (worktree) => path.resolve(worktree.worktree.path) === path.resolve(worktreePath),
    );
  }

  async findTerminalBySessionName(sessionName: string): Promise<RepositoryTreeNode | undefined> {
    return this.findTerminalNode(sessionName);
  }

  async describeSession(sessionName: string): Promise<{ repo: string; branch: string } | undefined> {
    const worktree = await this.findWorktreeNodeForSession(sessionName);
    if (worktree === undefined) return undefined;
    return {
      repo: path.basename(worktree.repositoryPath),
      branch: worktree.worktree.branch ?? path.basename(worktree.worktree.path),
    };
  }

  private async findTerminalNode(
    sessionName: string,
    worktreeMatches: (worktree: WorktreeNode) => boolean = () => true,
  ): Promise<TerminalNode | undefined> {
    const worktree = await this.findWorktreeNodeForSession(sessionName, worktreeMatches);
    if (worktree === undefined) return undefined;
    const terminals = await this.resolveChildren(worktree);
    for (const terminal of terminals) {
      if (terminal instanceof TerminalNode && terminal.terminal.sessionName === sessionName) {
        return terminal;
      }
    }
    return undefined;
  }

  private async findWorktreeNodeForSession(
    sessionName: string,
    worktreeMatches: (worktree: WorktreeNode) => boolean = () => true,
  ): Promise<WorktreeNode | undefined> {
    const repositories = await this.resolveChildren();
    for (const repository of repositories) {
      if (!(repository instanceof RepositoryNode)) continue;
      const worktrees = await this.resolveChildren(repository);
      for (const worktree of worktrees) {
        if (!(worktree instanceof WorktreeNode)) continue;
        // The session name embeds the worktree prefix — skip before the
        // per-worktree tmux query.
        if (!sessionName.startsWith(terminalSessionPrefix(worktree.worktree.path))) continue;
        if (!worktreeMatches(worktree)) continue;
        return worktree;
      }
    }
    return undefined;
  }

  private async resolveChildren(element?: RepositoryTreeNode): Promise<RepositoryTreeNode[]> {
    return (await Promise.resolve(this.getChildren(element))) ?? [];
  }

  private currentWorktreePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private isCurrentWorktree(worktreePath: string): boolean {
    const activeWorktreePath = this.currentWorktreePath();
    return activeWorktreePath !== undefined && path.resolve(worktreePath) === path.resolve(activeWorktreePath);
  }

  private isActiveRepository(repositoryPath: string): boolean {
    const repositoryCommonDir = this.repositoryCommonDirs.get(repositoryPath);
    return (
      repositoryCommonDir !== undefined &&
      repositoryCommonDir !== null &&
      repositoryCommonDir === this.activeRepositoryCommonDir
    );
  }

  private toParentWorktreeNode(worktreeNode: WorktreeNode): WorktreeNode {
    return new WorktreeNode(
      worktreeNode.repositoryPath,
      worktreeNode.worktree,
      this.isCurrentWorktree(worktreeNode.worktree.path),
      worktreeNode.mainWorktreePath,
      this.resolveWorktreeSessionName?.(worktreeNode.worktree.path),
      this.resolveWorktreePrs !== undefined,
    );
  }

  private getWorktreeChildren(element: RepositoryNode): RepositoryTreeNode[] | Promise<RepositoryTreeNode[]> {
    const commonDir =
      this.repositoryCommonDirCache.get(element.repositoryPath) ??
      this.repositoryCommonDirs.get(element.repositoryPath) ??
      undefined;

    if (commonDir !== undefined) {
      const cached = this.worktreeListCache.get(commonDir);
      if (cached !== undefined) {
        const visibleCached = this.visibleWorktrees(cached);
        this.refreshWorktreesInBackground(element.repositoryPath, commonDir, visibleCached);
        return this.toWorktreeNodes(
          element.repositoryPath,
          visibleCached,
          commonDir,
        );
      }
    }

    return this.loadWorktreeChildren(element.repositoryPath, commonDir);
  }

  private resolveActiveRepository(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.setActiveRepositoryCommonDir(null);
      return;
    }

    const cached = this.repositoryCommonDirCache.get(folder.uri.fsPath);
    if (cached !== undefined) this.setActiveRepositoryCommonDir(cached, false);
    if (this.resolvingActiveRepository) return;

    this.resolvingActiveRepository = true;
    void resolveCommonDirSafe(this.repositoryCommonDirCache, folder.uri.fsPath)
      .then((commonDir) => {
        this.setActiveRepositoryCommonDir(commonDir);
      })
      .finally(() => {
        this.resolvingActiveRepository = false;
      });
  }

  private resolveRepositoryCommonDir(repositoryPath: string): void {
    const cached = this.repositoryCommonDirCache.get(repositoryPath);
    if (cached !== undefined) {
      this.repositoryCommonDirs.set(repositoryPath, cached);
      this.refreshRepositoryCommonDirInBackground(repositoryPath, cached);
      return;
    }
    if (this.repositoryCommonDirs.has(repositoryPath) || this.resolvingRepositoryPaths.has(repositoryPath)) return;

    this.refreshRepositoryCommonDirInBackground(repositoryPath, undefined);
  }

  private refreshRepositoryCommonDirInBackground(repositoryPath: string, previous: string | undefined): void {
    if (this.resolvingRepositoryPaths.has(repositoryPath)) return;
    this.resolvingRepositoryPaths.add(repositoryPath);
    void getCommonDir(repositoryPath)
      .then(async (commonDir) => {
        await this.repositoryCommonDirCache.set(repositoryPath, commonDir);
        this.repositoryCommonDirs.set(repositoryPath, commonDir);
        if (previous !== commonDir) this._onDidChangeTreeData.fire(undefined);
      })
      .catch(() => {
        if (previous === undefined) {
          this.repositoryCommonDirs.set(repositoryPath, null);
          this._onDidChangeTreeData.fire(undefined);
        }
      })
      .finally(() => {
        this.resolvingRepositoryPaths.delete(repositoryPath);
      });
  }

  private setActiveRepositoryCommonDir(commonDir: string | null, fire = true): void {
    if (this.activeRepositoryCommonDir === commonDir) return;
    this.activeRepositoryCommonDir = commonDir;
    this.fireDeckDecorations(this.activeRepositoryDecorationInvalidationUris());
    if (fire) this._onDidChangeTreeData.fire(undefined);
  }

  private updateActiveWorktreeDecorationTarget(): AgentStatusDecorationResourceUri[] {
    const current = this.currentWorktreePath();
    const previous = this.activeWorktreePath;
    if (current === previous) return [];
    this.activeWorktreePath = current;
    const uris: AgentStatusDecorationResourceUri[] = [];
    if (previous !== undefined) uris.push(agentStatusDecorationResourceUri('worktree', previous));
    if (current !== undefined) uris.push(agentStatusDecorationResourceUri('worktree', current));
    return uris;
  }

  private activeRepositoryDecorationInvalidationUris(): AgentStatusDecorationResourceUri[] {
    return this.repositoryRegistry.list()
      .map((repositoryPath) => agentStatusDecorationResourceUri('repository', repositoryPath));
  }

  private fireDeckDecorations(uris: readonly AgentStatusDecorationResourceUri[]): void {
    if (uris.length === 0) return;
    this._onDidChangeDeckDecorations.fire([...uris]);
  }

  private async loadWorktreeChildren(
    repositoryPath: string,
    knownCommonDir: string | undefined,
  ): Promise<RepositoryTreeNode[]> {
    const pendingAtListStart = new Set(this.pendingWorktreeRemovals);
    const gitWorktrees = await listWorktrees(repositoryPath);
    const visibleWorktrees = this.visibleWorktrees(gitWorktrees, pendingAtListStart);
    const commonDir =
      knownCommonDir ??
      (await resolveCommonDirSafe(this.repositoryCommonDirCache, repositoryPath)) ??
      undefined;
    await this.pruneWorktreeOrder(commonDir, gitWorktrees);
    if (commonDir !== undefined) await this.worktreeListCache.set(commonDir, visibleWorktrees);
    return this.toWorktreeNodes(repositoryPath, visibleWorktrees, commonDir);
  }

  private async getPrChildren(element: WorktreeNode): Promise<RepositoryTreeNode[]> {
    if (!this.resolveWorktreePrs) return [];
    let prs: WorktreePr[];
    try {
      prs = await this.resolveWorktreePrs(element.worktree);
    } catch {
      return [new PrPlaceholderNode('PRs unavailable')];
    }
    if (prs.length === 0) return [new PrPlaceholderNode('no open PRs')];
    return prs.map((pr) => new PrNode(pr));
  }

  private async getTerminalChildren(element: WorktreeNode): Promise<RepositoryTreeNode[]> {
    // Wait for the DeckSocket to finish restoring before listing — otherwise a
    // reopen-after-kill reads an empty/partial session list, and the prune below
    // would mistake the not-yet-restored Terminals for dead ones and wipe the
    // stored TerminalOrder. Same hazard the tab-reattach gate guards against.
    await this.ensureSnapshotRestored();
    const liveTerminals = toCachedTerminalSessions(
      element.worktree.path,
      await this.tmux.listSessions(terminalSessionPrefix(element.worktree.path)),
    );
    const storedOrder = this.terminalOrders?.get(element.worktree.path);
    const prunedStoredOrder = storedOrder === undefined
      ? undefined
      : pruneOrder(storedOrder, new Set(liveTerminals.map((terminal) => terminal.sessionName)));
    if (prunedStoredOrder?.changed) {
      await this.terminalOrders?.set(element.worktree.path, prunedStoredOrder.order);
    }
    const terminals = reconcileTerminalOrder(
      prunedStoredOrder?.order,
      liveTerminals,
    );
    return this.toTerminalNodes(element, terminals);
  }

  private toTerminalNodes(element: WorktreeNode, terminals: readonly CachedTerminalSession[]): RepositoryTreeNode[] {
    const isActiveWorktree = this.isCurrentWorktree(element.worktree.path);
    const liveSessionNames = new Set(terminals.map((terminal) => terminal.sessionName));
    const nodes = terminals.map(
      (terminal) => {
        this.knownTerminals.set(terminal.sessionName, {
          repositoryPath: element.repositoryPath,
          worktreePath: element.worktree.path,
          sessionName: terminal.sessionName,
        });
        const status = this.agentStatuses?.get(terminal.sessionName);
        const existing = this.renderedTerminals.get(terminal.sessionName);
        if (existing) {
          existing.update(terminal, element, isActiveWorktree, status);
          return existing;
        }
        const node = new TerminalNode(terminal, element, isActiveWorktree, status);
        this.renderedTerminals.set(terminal.sessionName, node);
        return node;
      },
    );
    for (const [sessionName, node] of this.renderedTerminals) {
      if (node.worktreePath === element.worktree.path && !liveSessionNames.has(sessionName)) {
        this.renderedTerminals.delete(sessionName);
      }
    }
    this.syncAgentStatusDecorations();
    return nodes;
  }

  private refreshWorktreesInBackground(
    repositoryPath: string,
    commonDir: string,
    previous: readonly Worktree[],
  ): void {
    if (this.refreshingWorktrees.has(commonDir)) return;
    this.refreshingWorktrees.add(commonDir);
    const pendingAtListStart = new Set(this.pendingWorktreeRemovals);
    void listWorktrees(repositoryPath)
      .then(async (worktrees) => {
        const visibleWorktrees = this.visibleWorktrees(worktrees, pendingAtListStart);
        await this.pruneWorktreeOrder(commonDir, worktrees);
        if (sameWorktrees(previous, visibleWorktrees)) return;
        await this.worktreeListCache.set(commonDir, visibleWorktrees);
        this._onDidChangeTreeData.fire(undefined);
      })
      .catch(() => undefined)
      .finally(() => {
        this.refreshingWorktrees.delete(commonDir);
      });
  }

  private toWorktreeNodes(
    repositoryPath: string,
    gitWorktrees: readonly Worktree[],
    commonDir: string | undefined,
  ): WorktreeNode[] {
    const worktrees = this.visibleWorktrees(
      reconcileWorktreeOrder(
        commonDir === undefined ? undefined : this.worktreeOrders.get(commonDir),
        [...gitWorktrees],
      ),
    );
    const mainWorktreePath = gitWorktrees.find((w) => !w.bare)?.path;
    const nodes = worktrees.map((w) => {
      this.knownWorktreeRepositories.set(w.path, repositoryPath);
      return new WorktreeNode(
        repositoryPath,
        w,
        this.isCurrentWorktree(w.path),
        mainWorktreePath,
        this.resolveWorktreeSessionName?.(w.path),
        this.resolveWorktreePrs !== undefined,
      );
    });
    this.syncAgentStatusDecorations();
    return nodes;
  }

  private async pruneWorktreeOrder(commonDir: string | undefined, gitWorktrees: readonly Worktree[]): Promise<void> {
    if (commonDir === undefined) return;

    const storedOrder = this.worktreeOrders.get(commonDir);
    if (storedOrder === undefined) return;

    const prunedOrder = pruneOrder(storedOrder, new Set(gitWorktrees.map((worktree) => worktree.path)));
    if (prunedOrder.changed) {
      await this.worktreeOrders.set(commonDir, prunedOrder.order).catch(() => undefined);
    }
  }

  private visibleWorktrees(
    worktrees: readonly Worktree[],
    pendingAtListStart?: ReadonlySet<string>,
  ): Worktree[] {
    const currentlyVisible = excludePending(excludeBare(worktrees), this.pendingWorktreeRemovals);
    const notPending =
      pendingAtListStart === undefined
        ? currentlyVisible
        : excludePending(currentlyVisible, pendingAtListStart);
    return this.excludeInactive(notPending);
  }

  private excludeInactive(worktrees: readonly Worktree[]): Worktree[] {
    if (!this.hideInactiveWorktrees) return [...worktrees];
    // Show only worktrees with a live Deck terminal. The main/root worktree is
    // intentionally NOT special-cased: it is the workbench root, not a session,
    // so it should not appear even when a non-Deck session runs there.
    return worktrees.filter((worktree) => this.hasLiveSession(worktree.path));
  }

  private hasLiveSession(worktreePath: string): boolean {
    const prefix = terminalSessionPrefix(worktreePath);
    for (const sessionName of this.liveSessionNames) {
      if (sessionName.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Feed the current live Deck session names (from the terminal poll). */
  setLiveSessionNames(names: readonly string[]): void {
    const next = new Set(names);
    if (
      next.size === this.liveSessionNames.size &&
      [...next].every((name) => this.liveSessionNames.has(name))
    ) {
      return;
    }
    this.liveSessionNames = next;
    if (this.hideInactiveWorktrees) this._onDidChangeTreeData.fire(undefined);
  }

  private syncCachedDecorationWorktrees(repositoryPath: string): void {
    const commonDir =
      this.repositoryCommonDirCache.get(repositoryPath) ??
      this.repositoryCommonDirs.get(repositoryPath) ??
      undefined;
    if (commonDir === undefined || commonDir === null) return;

    const worktrees = this.worktreeListCache.get(commonDir);
    if (worktrees === undefined) return;
    for (const worktree of this.visibleWorktrees(worktrees)) {
      this.knownWorktreeRepositories.set(worktree.path, repositoryPath);
    }
  }

  private syncAgentStatusDecorations(): void {
    const statuses = [...(this.agentStatuses?.entries() ?? [])];
    this.agentStatusDecorationRollups.setStatuses(statuses);
    const terminals = new Map(this.knownTerminals);
    for (const [worktreePath, repositoryPath] of this.knownWorktreeRepositories) {
      const prefix = terminalSessionPrefix(worktreePath);
      for (const [sessionName] of statuses) {
        if (!sessionName.startsWith(prefix)) continue;
        terminals.set(sessionName, { repositoryPath, worktreePath, sessionName });
      }
    }
    this.agentStatusDecorationRollups.setTerminals([...terminals.values()]);
  }
}

function toDecorationUri(
  kind: AgentStatusDecorationNodeKind,
  id: string,
): vscode.Uri {
  return vscode.Uri.from(agentStatusDecorationResourceUri(kind, id));
}

function sameWorktrees(left: readonly Worktree[], right: readonly Worktree[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((worktree, index) => sameWorktree(worktree, right[index]));
}

function sameWorktree(left: Worktree, right: Worktree): boolean {
  return (
    left.path === right.path &&
    left.head === right.head &&
    left.branch === right.branch &&
    left.bare === right.bare &&
    left.detached === right.detached &&
    left.locked === right.locked &&
    left.createdAt === right.createdAt
  );
}
