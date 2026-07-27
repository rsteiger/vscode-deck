import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { RepositoryTreeProvider, type RepositoryTreeNode, type WorktreePr } from './tree/repositoryTree';
import { revealWithRetry } from './tree/revealWithRetry';
import { ActiveWorktreeStore } from './switch/activeWorktreeStore';
import { DetachedOpener } from './switch/detachedOpener';
import { WorktreeSwitcher } from './switch/worktreeSwitcher';
import { registerRepositorySeed } from './repository/registerRepositorySeed';
import {
  AddRepositoryCommand,
  VsCodeRepositoryFolderPicker,
  WorkspaceFolderRepositoryPicker,
} from './repository/addRepositoryCommand';
import { RepositoryRemovalCommand } from './repository/repositoryRemovalCommand';
import { ExternalGitWatch } from './repository/externalGitWatch';
import { RepositoryCommonDirCache, resolveCommonDirSafe } from './repository/repositoryCommonDirCache';
import { RepositoryRegistryStore } from './repository/repositoryRegistryStore';
import { watchGitCommonDir } from './repository/vscodeExternalGitWatch';
import { AddWorktreeCommand } from './worktree/addWorktreeCommand';
import { BranchDeletionPreferenceStore } from './worktree/branchDeletionPreferenceStore';
import { WorktreeListCacheStore } from './worktree/worktreeListCacheStore';
import { WorktreeRemovalCommand } from './worktree/worktreeRemovalCommand';
import { WorktreeRootStore } from './worktree/worktreeRootStore';
import { DeckTreeDragAndDropController } from './tree/deckTreeDragAndDropController';
import { SectionStore } from './section/sectionStore';
import { listWorktrees } from './git/worktrees';
import { DeckBoardViewProvider, type DeckBoardHandlers } from './webview/deckBoardViewProvider';
import {
  groupIntoSections,
  type BoardWorktree,
  type DeckBoard,
} from './webview/deckBoardModel';
import { WorktreeOrderStore } from './worktree/worktreeOrderStore';
import { AddTerminalCommand, createAndOpenTerminal } from './terminal/addTerminalCommand';
import { RunLauncherCommand } from './terminal/runLauncherCommand';
import {
  ImportClaudeSessionCommand,
  claudeSessionNamesByCwd,
} from './agent/importClaudeSession';
import { WorktreeCreateLauncherRunner } from './terminal/worktreeCreateLauncherRunner';
import { TerminalRemovalCommand } from './terminal/killTerminalCommand';
import { OpenTerminalCommand } from './terminal/openTerminalCommand';
import { OpenTerminalInNewWindowCommand } from './terminal/openTerminalInNewWindowCommand';
import { PendingTerminalOpenStore } from './terminal/pendingTerminalOpenStore';
import { TerminalCascade } from './terminal/terminalCascade';
import { TerminalOrderStore } from './terminal/terminalOrderStore';
import {
  TerminalEditorProvider,
  terminalEditorViewType,
} from './terminal/terminalEditorProvider';
import { DisconnectedTabWatch } from './terminal/disconnectedTabWatch';
import { TmuxCli, type TmuxSession } from './terminal/tmuxCli';
import { terminalSessionNumber, terminalSessionPrefix } from './terminal/tmuxSafe';
import { tmuxPreflight } from './terminal/tmuxPreflight';
import { SessionUriCodec } from './terminal/sessionUriCodec';
import { renderDeckConf } from './terminal/deckConf';
import { resolveDeckTmuxOptions, type DeckTmuxOptions } from './terminal/deckTmuxOptions';
import {
  TERMINAL_SNAPSHOT_ANCHOR_SESSION,
  TerminalSnapshotRuntime,
} from './terminal/terminalSnapshotRuntime';
import {
  formatTerminalSnapshotRestoreProgress,
  terminalSnapshotLastSaveTime,
  type TerminalSnapshotRestoreFeedback,
} from './terminal/terminalSnapshotRestoreFeedback';
import { createRestoreCoordinator } from './terminal/restoreGate';
import { deckSocketPath, WedgeRecovery } from './terminal/deckSocketRecovery';
import { SNAPSHOT_LOCK_FILENAME, RecoveryLock } from './terminal/recoveryLock';
import { AgentSidecarStore } from './agent/agentSidecarStore';
import { AgentExitSweep } from './agent/agentExitSweep';
import { PsProcessProbe } from './agent/agentLivenessProbe';
import { AgentPaneProbe } from './agent/agentPaneProbe';
import { DeckDecorationProvider } from './tree/deckDecorationProvider';
import { AgentStatusNotifier } from './agent/agentStatusNotifier';
import { AgentStatusStore } from './agent/agentStatusStore';
import { TerminalPoll } from './terminal/terminalPoll';
import type { AgentName } from './agent/agentTypes';
import { AgentDetection } from './agent/agentDetection';
import { AgentSetupPrompt, type AgentConfigChange } from './agent/agentSetupPrompt';
import { HookInstaller, type HookReconcileResult } from './agent/hookInstaller';
import { rewriteTerminalSnapshotAgentSessions } from './agent/terminalSnapshotAgentSessions';
import { ResumeTemplate } from './agent/resumeTemplate';
import { SnapshotRewriter } from './agent/snapshotRewriter';

let terminalSnapshotRuntime: TerminalSnapshotRuntime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tmuxAvailability = await tmuxPreflight();
  await vscode.commands.executeCommand('setContext', 'deck.tmuxAvailable', tmuxAvailability.available);
  const initialTmuxOptions = deckTmuxOptionsFromSettings();
  showDeckTmuxOptionWarnings(initialTmuxOptions);
  const tmuxConfigPath = await writeDeckConf(context, initialTmuxOptions);
  const tmux = new TmuxCli(tmuxConfigPath);
  await applyDeckTmuxOptionsIfServerRunning(tmux, initialTmuxOptions, tmuxAvailability.available);
  const deckDir = deckDataDir();
  let treeView: vscode.TreeView<RepositoryTreeNode> | undefined;
  const agentSidecars = new AgentSidecarStore(join(deckDir, 'hooks'));
  const agentStatuses = new AgentStatusStore(join(deckDir, 'status'), 100);
  const agentStatusWatch = await agentStatuses.start();
  const resolveAgentName = async (sessionName: string): Promise<AgentName | undefined> => {
    const status = agentStatuses.get(sessionName);
    if (status !== undefined) return status.agent ?? 'claude';

    try {
      return (await agentSidecars.read(sessionName))?.agent;
    } catch {
      return undefined;
    }
  };
  const tmuxSessionsWithAgentNames = {
    listSessions: async (prefix?: string): Promise<TmuxSession[]> => {
      const sessions = await tmux.listSessions(prefix);
      return Promise.all(sessions.map(async (session) => {
        const agentName = session.agentName ?? await resolveAgentName(session.sessionName);
        if (agentName === undefined) return session;
        return { ...session, agentName };
      }));
    },
  };
  let agentExitSweep: AgentExitSweep | undefined;
  let terminalPoll: TerminalPoll | undefined;
  let agentExitSweepReady = false;
  const wakeAgentExitSweep = () => {
    if (!agentExitSweepReady) return;
    agentExitSweep?.wake();
  };
  const startAgentExitSweep = () => {
    agentExitSweepReady = true;
    agentExitSweep?.wake();
  };
  const activeTerminalReadWatch = agentStatuses.onDidChange(() => {
    void markActiveTerminalRead(agentStatuses);
  });
  const agentExitSweepWakeWatch = agentStatuses.onDidChange(() => {
    wakeAgentExitSweep();
  });
  void markActiveTerminalRead(agentStatuses);
  const hookInstaller = new HookInstaller({
    claudeSettingsPath: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    codexHooksPath: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'),
    hookScriptPath: join(deckDir, 'bin', 'deck-claude-hook.sh'),
    codexHookScriptPath: join(deckDir, 'bin', 'deck-codex-hook.sh'),
    sidecarDir: join(deckDir, 'hooks'),
  });
  const agentSetupPrompt = new AgentSetupPrompt({
    detector: new AgentDetection(),
    installer: hookInstaller,
    globalState: context.globalState,
    notifications: vscode.window,
    reviewer: {
      showChanges: showAgentHookConfigChanges,
    },
  });

  terminalSnapshotRuntime = tmuxAvailability.available
    ? new TerminalSnapshotRuntime(
        tmux,
        () => terminalSnapshotSaveScriptPath(context),
        () => terminalSnapshotRestoreScriptPath(context),
        () => deckDir,
        () => rewriteTerminalSnapshotAgentSessions(
          join(deckDir, 'resurrect', 'last'),
          agentSidecars,
          new SnapshotRewriter(resumeTemplateFromSettings()),
        ),
        new WedgeRecovery({
          isServerRunning: () => tmux.isServerRunning(),
          startServer: () => tmux.newAnchorSession(TERMINAL_SNAPSHOT_ANCHOR_SESSION, deckDir),
          socketPath: () => deckSocketPath(),
          socketExists,
          removeSocket: (path) => rm(path, { force: true }),
          recoveryLock: new RecoveryLock({
            deckDir,
            isHealthy: () => tmux.isServerRunning(),
          }),
        }),
        terminalSnapshotRestoreFeedback(deckDir, () => treeView),
        new RecoveryLock({
          deckDir,
          lockFilename: SNAPSHOT_LOCK_FILENAME,
          isHealthy: () => tmux.isServerRunning(),
        }),
      )
    : undefined;

  // A terminal-tab reattach (which issues `new-session -A`) awaits this gate
  // before touching tmux, so it can never resurrect a session blank ahead of
  // restore — on reopen after reboot, or when the DeckSocket dies while VS Code
  // stays open. See restoreGate.ts.
  const snapshotRuntime = terminalSnapshotRuntime;
  const restoreCoordinator = snapshotRuntime
    ? createRestoreCoordinator({
        listSessions: () => tmux.listSessions(),
        restore: () => snapshotRuntime.restoreOnActivation(),
        restoreLock: new RecoveryLock({
          deckDir,
          lockFilename: SNAPSHOT_LOCK_FILENAME,
          isHealthy: () => tmux.isServerRunning(),
        }),
      })
    : undefined;
  const ensureSnapshotRestored = restoreCoordinator
    ? async () => {
        await restoreCoordinator.ensureRestored();
      }
    : () => Promise.resolve();
  const repositoryRegistry = new RepositoryRegistryStore(context.globalState);

  const activeWorktrees = new ActiveWorktreeStore(context.globalState);
  const worktreeRoots = new WorktreeRootStore(context.globalState);
  const worktreeOrders = new WorktreeOrderStore(context.globalState);
  const terminalOrders = new TerminalOrderStore(context.globalState);
  const worktreeListCache = new WorktreeListCacheStore(context.globalState);
  const pendingTerminalOpens = new PendingTerminalOpenStore(context.globalState);
  const pendingWorktreeRemovals = new Set<string>();
  const repositoryCommonDirCache = new RepositoryCommonDirCache(context.globalState);
  const branchDeletionPreferences = new BranchDeletionPreferenceStore(context.globalState);
  const switcher = new WorktreeSwitcher(activeWorktrees);
  const detachedOpener = new DetachedOpener();
  const tree = new RepositoryTreeProvider(
    repositoryRegistry,
    activeWorktrees,
    worktreeOrders,
    worktreeListCache,
    repositoryCommonDirCache,
    tmuxSessionsWithAgentNames,
    tmuxAvailability.available,
    pendingWorktreeRemovals,
    agentStatuses,
    terminalOrders,
    ensureSnapshotRestored,
  );
  // Label worktree rows with their Claude session name (one session per
  // worktree). Cached briefly so getTreeItem does not re-read the sessions
  // dir on every row render.
  let sessionNameCache = new Map<string, string>();
  let sessionNameCacheAt = 0;
  tree.resolveWorktreeSessionName = (worktreePath) => {
    const now = Number(process.hrtime.bigint() / 1_000_000n);
    if (now - sessionNameCacheAt > 2000) {
      sessionNameCache = claudeSessionNamesByCwd();
      sessionNameCacheAt = now;
    }
    return sessionNameCache.get(worktreePath);
  };
  // List a worktree's open PRs as tree children (one session per worktree).
  // gh infers the repo from the worktree cwd; results cached per branch so the
  // terminal poll's frequent tree refreshes do not re-hit gh.
  const prCache = new Map<string, { at: number; prs: WorktreePr[] }>();
  const execFileAsync = promisify(execFile);
  const resolveWorktreePrs = async (worktree: {
    path: string;
    branch?: string;
  }): Promise<WorktreePr[]> => {
    if (!worktree.branch) return [];
    const cached = prCache.get(worktree.branch);
    const now = Number(process.hrtime.bigint() / 1_000_000n);
    if (cached && now - cached.at < 30_000) return cached.prs;
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--head', worktree.branch, '--state', 'open',
       '--json', 'number,title,url'],
      { cwd: worktree.path, maxBuffer: 8 * 1024 * 1024 },
    );
    const prs: WorktreePr[] = JSON.parse(stdout).map(
      (p: { number: number; title: string; url: string }) => ({
        number: p.number,
        title: p.title,
        url: p.url,
      }),
    );
    prCache.set(worktree.branch, { at: now, prs });
    return prs;
  };
  tree.resolveWorktreePrs = resolveWorktreePrs;
  // Single project: render worktrees at the tree root, no repository node.
  tree.flattenRepositories = true;
  // User-created sections: worktrees group under sections you create and drag
  // between. Persisted to a file since code-server does not keep globalState.
  const sectionStore = new SectionStore(undefined, () => {
    tree.sections = sectionStore.list();
    refreshTree();
  });
  tree.sections = sectionStore.list();
  tree.resolveWorktreeSectionId = (worktreePath) =>
    sectionStore.sectionOf(worktreePath);

  // The board webview (SCM-style sections) shows worktrees with a live Deck
  // session, grouped by section. It shares the tree's data sources; the live
  // session set is tracked here (the tree only seeds it when its hide filter is
  // on, so the board keeps its own always-updated copy).
  let liveSessionNames: readonly string[] = [];
  // The poll only emits session-set changes after its baseline, so the board
  // seeds the live set itself the first time it builds (i.e. when the view is
  // opened) rather than at activation, keeping the startup sequence unchanged.
  let liveSessionsSeeded = false;
  const seedLiveSessions = async (): Promise<void> => {
    if (!tmuxAvailability.available) return;
    try {
      const sessions = await tmuxSessionsWithAgentNames.listSessions();
      liveSessionNames = sessions.map((session) => session.sessionName);
    } catch (error) {
      console.warn('Deck: board session seed failed', error);
    }
  };
  const worktreeHasLiveSession = (worktreePath: string): boolean => {
    const prefix = terminalSessionPrefix(worktreePath);
    return liveSessionNames.some((name) => name.startsWith(prefix));
  };
  const worktreeStatus = (worktreePath: string): string => {
    const prefix = terminalSessionPrefix(worktreePath);
    const sessionName = liveSessionNames.find((name) => name.startsWith(prefix));
    if (!sessionName) return 'gone';
    const status = agentStatuses.get(sessionName)?.status;
    return status === 'inProgress' ? 'busy' : 'idle';
  };
  const buildBoardModel = async (): Promise<DeckBoard> => {
    if (!liveSessionsSeeded) {
      liveSessionsSeeded = true;
      await seedLiveSessions();
    }
    const sessionNames = claudeSessionNamesByCwd();
    const worktrees: BoardWorktree[] = [];
    for (const repositoryPath of repositoryRegistry.list()) {
      let gitWorktrees;
      try {
        gitWorktrees = await listWorktrees(repositoryPath);
      } catch {
        continue; // Repository unreadable this pass — skip it.
      }
      for (const worktree of gitWorktrees) {
        if (worktree.bare) continue;
        if (!worktreeHasLiveSession(worktree.path)) continue;
        worktrees.push({
          path: worktree.path,
          label:
            sessionNames.get(worktree.path) ??
            worktree.branch ??
            basename(worktree.path),
          status: worktreeStatus(worktree.path),
          prs: await resolveWorktreePrs(worktree),
        });
      }
    }
    return {
      sections: groupIntoSections(
        sectionStore.list(),
        worktrees,
        (worktreePath) => sectionStore.sectionOf(worktreePath),
      ),
    };
  };
  const boardHandlers: DeckBoardHandlers = {
    openWorktree: (worktreePath) =>
      void vscode.commands.executeCommand('deck.revealWorktreeTerminal', worktreePath),
    openPr: (prNumber, url) =>
      void vscode.commands.executeCommand('deck.openPr', prNumber, url),
    assignSection: (worktreePath, sectionId) =>
      sectionStore.assign(worktreePath, sectionId),
    addSection: () => void vscode.commands.executeCommand('deck.addSection'),
    renameSection: async (sectionId) => {
      const current = sectionStore.list().find((section) => section.id === sectionId);
      const name = await vscode.window.showInputBox({
        prompt: 'Rename section',
        value: current?.name ?? '',
      });
      if (name?.trim()) sectionStore.renameSection(sectionId, name.trim());
    },
    removeSection: async (sectionId) => {
      const current = sectionStore.list().find((section) => section.id === sectionId);
      const confirm = await vscode.window.showWarningMessage(
        `Delete section "${current?.name ?? ''}"? Its worktrees become ungrouped.`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') sectionStore.removeSection(sectionId);
    },
  };
  const boardProvider = new DeckBoardViewProvider(buildBoardModel, boardHandlers);
  const refreshBoard = () => void boardProvider.refresh();
  // Repaint the board when an agent's status changes (worktree status dots).
  // Registered here (before AgentStatusNotifier) so it does not disturb code
  // that relies on the notifier being the last onDidChange listener.
  const boardStatusWatch = agentStatuses.onDidChange(refreshBoard);
  agentExitSweep = tmuxAvailability.available
    ? new AgentExitSweep({
        sidecars: agentSidecars,
        statuses: agentStatuses,
        teardown: tmux,
        serverStart: tmux,
        paneProbe: new AgentPaneProbe(tmux, new PsProcessProbe()),
        paneCapture: tmux,
        onError: (error) => console.warn('Deck: agent exit sweep failed', error),
      })
    : undefined;
  const externalGitWatch = new ExternalGitWatch(watchGitCommonDir, refreshTree);
  let externalGitSyncVersion = 0;

  function refreshTree(): void {
    tree.refresh();
    refreshBoard();
    terminalPoll?.start();
    wakeAgentExitSweep();
    syncExternalGitWatches();
  }

  function syncExternalGitWatches(): void {
    const version = ++externalGitSyncVersion;
    void registeredCommonDirs(repositoryRegistry, repositoryCommonDirCache).then((commonDirs) => {
      if (version !== externalGitSyncVersion) return;
      externalGitWatch.sync(commonDirs);
    });
  }

  syncExternalGitWatches();

  const addTerminal = new AddTerminalCommand(
    tmux,
    refreshTree,
    undefined,
    ensureSnapshotRestored,
  );
  const importClaudeSession = new ImportClaudeSessionCommand(tmux, {
    refresh: refreshTree,
    beforeCreate: ensureSnapshotRestored,
  });
  const runLauncher = new RunLauncherCommand(tmux, {
    refresh: refreshTree,
    beforeCreate: ensureSnapshotRestored,
    resolveCommonDir: (repositoryPath) =>
      resolveCommonDirSafe(repositoryCommonDirCache, repositoryPath),
  });
  const worktreeCreateLaunchers = new WorktreeCreateLauncherRunner(tmux, {
    refresh: refreshTree,
    beforeCreate: ensureSnapshotRestored,
    resolveCommonDir: (repositoryPath) =>
      resolveCommonDirSafe(repositoryCommonDirCache, repositoryPath),
  });
  const terminalEditorProvider = new TerminalEditorProvider(
    context.extensionUri,
    tmuxConfigPath,
    undefined,
    undefined,
    refreshTree,
    // %window-renamed from any open terminal's control client → relabel the row
    // live (automatic-rename tracks the foreground command); event-driven, no poll.
    async (sessionName) => {
      const session = await tmux.terminalSession(sessionName);
      if (session) tree.refreshTerminalDisplays([session]);
    },
    (sessionName) => tmux.terminalSession(sessionName),
    ensureSnapshotRestored,
    resolveAgentName,
  );
  const disconnectedTabs = new DisconnectedTabWatch({
    panelFor: (sessionName) => terminalEditorProvider.panelFor(sessionName),
  });
  terminalPoll = tmuxAvailability.available
    ? new TerminalPoll({
        listSessions: () => tmux.listSessions(),
        isFocused: () => vscode.window.state.focused,
        onDidChangeFocus: (listener) =>
          vscode.window.onDidChangeWindowState((state) => listener(state.focused)),
        onError: (error) => console.warn('Deck: terminal poll failed', error),
        resolveAgentName,
      })
    : undefined;
  const terminalPollWatch = terminalPoll?.onChange((changedSessions) => {
    tree.refreshTerminalDisplays(changedSessions);
    terminalEditorProvider.refreshTitles(changedSessions.map((session) => session.sessionName));
  });
  const terminalPollSessionSetWatch = terminalPoll?.onDidChangeSessionSet(
    (sessionNames) => {
      liveSessionNames = sessionNames;
      liveSessionsSeeded = true;
      tree.setLiveSessionNames(sessionNames);
      refreshTree();
    },
  );
  const applyHideInactiveSetting = (refresh: boolean) => {
    const next = vscode.workspace
      .getConfiguration('deck')
      .get<boolean>('hideWorktreesWithoutTerminals', false);
    if (next === tree.hideInactiveWorktrees) return;
    tree.hideInactiveWorktrees = next;
    // Only seed the live-session set when the filter is on — the poll otherwise
    // only emits on *changes* after its baseline, so the hide filter would have
    // an empty set until a session appears or disappears.
    if (next && tmuxAvailability.available) {
      void tmuxSessionsWithAgentNames
        .listSessions()
        .then((sessions) => tree.setLiveSessionNames(sessions.map((s) => s.sessionName)))
        .catch((error) => console.warn('Deck: initial session seed failed', error));
    }
    if (refresh) refreshTree();
  };
  applyHideInactiveSetting(false);
  const hideInactiveConfigWatch = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('deck.hideWorktreesWithoutTerminals')) {
      applyHideInactiveSetting(true);
    }
  });
  terminalPoll?.start();
  const openTerminal = new OpenTerminalCommand({
    terminalPanels: terminalEditorProvider,
  });
  const openTerminalInNewWindow = new OpenTerminalInNewWindowCommand(pendingTerminalOpens);
  const removeAgentStatus = (sessionName: string) => agentStatuses.remove(sessionName);
  const terminalRemoval = new TerminalRemovalCommand(
    tmux,
    refreshTree,
    confirmTerminalRemoval,
    undefined,
    removeAgentStatus,
  );
  const terminalCascade = new TerminalCascade(tmux, undefined, removeAgentStatus);
  const addWorktree = new AddWorktreeCommand(
    switcher,
    detachedOpener,
    refreshTree,
    worktreeRoots,
    worktreeListCache,
    repositoryCommonDirCache,
    worktreeCreateLaunchers,
  );
  const revealRepository = async (repositoryPath: string) => {
    const roots = tree.getChildren();
    if (!Array.isArray(roots)) return;
    const repository = roots.find((node) => 'repositoryPath' in node && node.repositoryPath === repositoryPath);
    if (!repository) return;
    try {
      await treeView?.reveal(repository, { expand: true, select: true });
    } catch (error) {
      // Reveal can fail if VS Code's internal element map is out of sync
      // with the freshly-constructed RepositoryNode; the repository is still in
      // the tree, just not scrolled into view.
      console.warn('Deck: TreeView.reveal failed', error);
    }
  };

  // Auto-register the open workspace folders as Deck repositories. Deck's
  // globalState registry does not persist under code-server (no state.vscdb),
  // so a fresh browser or reload would otherwise start with "No repositories
  // yet"; seeding from the open folders makes the current repo appear
  // deterministically. registerRepositorySeed is idempotent — an already
  // registered folder or a non-git folder is a no-op.
  const autoSeedWorkspaceRepositories = async () => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        await registerRepositorySeed({
          seedPath: folder.uri.fsPath,
          registry: repositoryRegistry,
          activeWorktrees,
          refresh: refreshTree,
          reveal: revealRepository,
          repositoryCommonDirCache,
        });
      } catch (error) {
        console.warn('Deck: auto-seed failed for', folder.uri.fsPath, error);
      }
    }
  };
  void autoSeedWorkspaceRepositories();

  const dragAndDropController = new DeckTreeDragAndDropController(
    refreshTree,
    repositoryRegistry,
    worktreeOrders,
    terminalOrders,
    tmux,
    activeWorktrees,
    switcher,
    detachedOpener,
    revealRepository,
    repositoryCommonDirCache,
    sectionStore,
  );
  const removeWorktree = new WorktreeRemovalCommand(
    activeWorktrees,
    refreshTree,
    branchDeletionPreferences,
    worktreeListCache,
    repositoryCommonDirCache,
    terminalCascade,
    pendingWorktreeRemovals,
  );
  const removeRepository = new RepositoryRemovalCommand(
    repositoryRegistry,
    activeWorktrees,
    worktreeRoots,
    worktreeOrders,
    refreshTree,
    terminalCascade,
    worktreeListCache,
  );

  treeView = vscode.window.createTreeView('deck.repositories', {
    treeDataProvider: tree,
    dragAndDropController,
    canSelectMany: false,
  });
  const deckDecorationProvider = new DeckDecorationProvider(
    agentStatuses,
    tree.agentStatusDecorationRollups,
    {
      isActiveRepository: (id) => tree.isActiveRepositoryDecorationTarget(id),
      isActiveWorktree: (id) => tree.isActiveWorktreeDecorationTarget(id),
      onDidChange: (listener) => tree.onDidChangeDeckDecorations(listener),
    },
    disconnectedTabs,
  );
  const deckDecorationWatch = vscode.window.registerFileDecorationProvider(deckDecorationProvider);
  const disconnectedTabBadgeWatch = disconnectedTabs.onDidChangeDisconnectedTabs((uris) => {
    deckDecorationProvider.invalidate(uris);
  });
  const agentStatusCollapseWatch = treeView.onDidCollapseElement((event) => {
    deckDecorationProvider.fire(tree.setCollapsed(event.element, true));
  });
  const agentStatusExpandWatch = treeView.onDidExpandElement((event) => {
    deckDecorationProvider.fire(tree.setCollapsed(event.element, false));
  });
  // Kick off the reboot restore after the tree view exists so restore feedback
  // can show the sidebar banner while the snapshot is being restored.
  const activationRestore = restoreCoordinator?.ensureRestored();
  if (activationRestore) {
    void activationRestore
      .then(refreshTree)
      .catch((error) => {
        console.warn('Deck: refreshing tree after TerminalSnapshot restore failed', error);
      })
      .finally(startAgentExitSweep);
  } else {
    startAgentExitSweep();
  }
  const agentStatusNotifierWatch = new AgentStatusNotifier({
    store: agentStatuses,
    settings: {
      notifyOnNeedsInput: () => agentStatusNotificationEnabled('notifyOnNeedsInput'),
      notifyOnCompleted: () => agentStatusNotificationEnabled('notifyOnCompleted'),
    },
    windowState: {
      isFocused: () => vscode.window.state.focused,
      activeTerminalSessionName: () => activeDeckTerminal()?.sessionName,
    },
    notifications: {
      showWarningMessage: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
      showInformationMessage: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
    },
    openTerminal: (sessionName) => openAgentStatusTerminal(tree, treeView, openTerminal, sessionName),
    resolveTerminalSession: (sessionName) => tmux.terminalSession(sessionName),
    describeSession: (sessionName) => tree.describeSession(sessionName),
  }).start();
  const addRepository = new AddRepositoryCommand(
    new WorkspaceFolderRepositoryPicker(new VsCodeRepositoryFolderPicker()),
    repositoryRegistry,
    activeWorktrees,
    switcher,
    detachedOpener,
    refreshTree,
    revealRepository,
    repositoryCommonDirCache,
  );

  let lastRevealedActiveTerminalSessionName: string | undefined;
  const revealActiveTerminalAfterNavigation = async () => {
    const activeTerminalSessionName = activeDeckTerminal()?.sessionName;
    // VS Code also emits tab changes for Deck's agent icon/title churn, not
    // just navigation. Only reselect the tree row when the active Terminal
    // identity changes, so status/title updates don't steal manual selection.
    if (activeTerminalSessionName === lastRevealedActiveTerminalSessionName) return;
    lastRevealedActiveTerminalSessionName = activeTerminalSessionName;
    await revealActiveTerminalInTree(tree, treeView);
  };

  context.subscriptions.push(
    treeView,
    vscode.window.registerWebviewViewProvider(
      DeckBoardViewProvider.viewType,
      boardProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    boardStatusWatch,
    hideInactiveConfigWatch,
    agentStatusWatch,
    activeTerminalReadWatch,
    agentExitSweepWakeWatch,
    ...(agentExitSweep ? [agentExitSweep] : []),
    ...(terminalPoll ? [terminalPoll] : []),
    ...(terminalPollWatch ? [terminalPollWatch] : []),
    ...(terminalPollSessionSetWatch ? [terminalPollSessionSetWatch] : []),
    deckDecorationProvider,
    deckDecorationWatch,
    disconnectedTabBadgeWatch,
    agentStatusCollapseWatch,
    agentStatusExpandWatch,
    agentStatusNotifierWatch,
    externalGitWatch,
    vscode.window.registerCustomEditorProvider(terminalEditorViewType, terminalEditorProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    }),
    terminalEditorProvider,
    disconnectedTabs,
    vscode.commands.registerCommand('deck.refresh', () => {
      refreshTree();
    }),
    vscode.commands.registerCommand('deck.addRepository', () => addRepository.run()),
    vscode.commands.registerCommand('deck.addWorktree', (node) => addWorktree.run(node)),
    // View-title "+": with the flattened single-project tree there is no
    // repository node to hang the worktree command on, so resolve the repo
    // from the registry (prompt only when more than one is registered).
    vscode.commands.registerCommand('deck.addWorktreeHere', async () => {
      const repositories = repositoryRegistry.list();
      let repositoryPath = repositories[0];
      if (repositories.length > 1) {
        const picked = await vscode.window.showQuickPick(repositories, {
          placeHolder: 'Select repository',
        });
        if (!picked) return;
        repositoryPath = picked;
      }
      if (!repositoryPath) {
        void vscode.commands.executeCommand('deck.addRepository');
        return;
      }
      await addWorktree.run({ repositoryPath });
    }),
    vscode.commands.registerCommand('deck.addSection', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'New section name',
        placeHolder: 'e.g. Active, Backlog, Shipping',
      });
      if (!name?.trim()) return;
      sectionStore.addSection(name.trim());
    }),
    vscode.commands.registerCommand(
      'deck.renameSection',
      async (node: { sectionId?: string; label?: string } | undefined) => {
        if (!node?.sectionId) return;
        const name = await vscode.window.showInputBox({
          prompt: 'Rename section',
          value: typeof node.label === 'string' ? node.label : '',
        });
        if (!name?.trim()) return;
        sectionStore.renameSection(node.sectionId, name.trim());
      },
    ),
    vscode.commands.registerCommand(
      'deck.removeSection',
      async (node: { sectionId?: string; label?: string } | undefined) => {
        if (!node?.sectionId) return;
        const confirm = await vscode.window.showWarningMessage(
          `Delete section "${node.label}"? Its worktrees become ungrouped.`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') return;
        sectionStore.removeSection(node.sectionId);
      },
    ),
    vscode.commands.registerCommand('deck.addTerminal', (node) => addTerminal.run(node)),
    vscode.commands.registerCommand('deck.runLauncher', (node) => runLauncher.run(node)),
    vscode.commands.registerCommand('deck.importClaudeSession', (node) =>
      importClaudeSession.run(node),
    ),
    vscode.commands.registerCommand('deck.openTerminal', (node) => openTerminal.run(node)),
    // Open a PR child: prefer PR Dash's reload-free in-window diff view, fall
    // back to the browser when PR Dash is not installed.
    vscode.commands.registerCommand(
      'deck.openPr',
      async (prNumber: unknown, url: unknown) => {
        try {
          await vscode.commands.executeCommand('prDash.openPrByNumber', prNumber);
        } catch {
          if (typeof url === 'string') {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
        }
      },
    ),
    // Reveal (or create) a worktree's Deck terminal by path, in this window —
    // lets sibling extensions (PR Dash) surface a worktree's agent without a
    // window reload. Reveals the lowest-numbered existing session, else creates.
    vscode.commands.registerCommand(
      'deck.revealWorktreeTerminal',
      async (worktreePath: unknown) => {
        if (typeof worktreePath !== 'string' || !tmuxAvailability.available) return;
        const codec = new SessionUriCodec();
        const sessions = await tmux.listSessions(terminalSessionPrefix(worktreePath));
        if (sessions.length > 0) {
          const term = Math.min(
            ...sessions.map((s) => terminalSessionNumber(worktreePath, s.sessionName)),
          );
          await vscode.commands.executeCommand(
            'vscode.openWith',
            codec.encode({ worktreePath, term }),
            terminalEditorViewType,
            { viewColumn: vscode.ViewColumn.Active },
          );
          return;
        }
        await ensureSnapshotRestored();
        await createAndOpenTerminal(tmux, { worktree: { path: worktreePath } }, codec);
        refreshTree();
      },
    ),
    vscode.commands.registerCommand('deck.openTerminalInNewWindow', (node) =>
      openTerminalInNewWindow.run(node),
    ),
    // cmd+backspace (keybinding) passes no node, so fall back to the selected
    // row. Scoped to Terminals only: a Worktree row can't be selected by keyboard
    // without switching (its click reloads the window), and VS Code gives no API
    // to read the keyboard-focused tree item (microsoft/vscode#130880) — so
    // Worktree delete lives in the right-click menu, which does receive the row.
    vscode.commands.registerCommand('deck.killTerminal', (node) =>
      terminalRemoval.run(node ?? treeView.selection[0]),
    ),
    vscode.commands.registerCommand('deck.terminal.find', () => terminalEditorProvider.showFind()),
    vscode.commands.registerCommand('deck.reopenTerminals', () => disconnectedTabs.reopenUnwiredTabs()),
    vscode.commands.registerCommand('deck.installAgentHooks', () => agentSetupPrompt.run({ explicit: true })),
    vscode.commands.registerCommand('deck.removeAgentHooks', () => agentSetupPrompt.uninstall()),
    vscode.commands.registerCommand('deck.removeRepository', (node) => removeRepository.run(node)),
    vscode.commands.registerCommand('deck.removeWorktree', (node) => removeWorktree.run(node)),
    vscode.commands.registerCommand('deck.openWorktreeInNewWindow', (node: { worktree: { path: string } }) =>
      detachedOpener.open(node.worktree.path),
    ),
    vscode.commands.registerCommand('deck.switchWorktree', async (node: { worktree: { path: string } }) => {
      await switcher.switchTo(node.worktree.path);
      refreshTree();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshTree),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('deck.tmux')) return;
      const tmuxOptions = deckTmuxOptionsFromSettings();
      showDeckTmuxOptionWarnings(tmuxOptions);
      await writeDeckConf(context, tmuxOptions);
      await applyDeckTmuxOptionsIfServerRunning(tmux, tmuxOptions, tmuxAvailability.available);
    }),
    vscode.window.tabGroups.onDidChangeTabs(async () => {
      await markActiveTerminalRead(agentStatuses);
      await revealActiveTerminalAfterNavigation();
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(async () => {
      await markActiveTerminalRead(agentStatuses);
      await revealActiveTerminalAfterNavigation();
    }),
    // Focusing back with the agent's tab active is when you actually read it —
    // markActiveTerminalRead no-ops while unfocused, so re-run it on refocus.
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      refreshTree();
      void markActiveTerminalRead(agentStatuses);
    }),
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) refreshTree();
    }),
  );
  disconnectedTabs.start();
  if (terminalSnapshotRuntime) {
    context.subscriptions.push(terminalSnapshotRuntime.startPeriodicSave(5 * 60 * 1000));
    await openPendingTerminalForCurrentWorktree(pendingTerminalOpens, tmux);
    await activationRestore?.catch(() => undefined);
    hookInstaller.reconcileInstalledHooks().then(showAgentHookUpgradeNotifications).catch((error) =>
      console.warn('Deck: reconciling agent hooks failed', error),
    );
    // Agent resume rides on the tmux-backed snapshot machinery, so only offer
    // setup when that's available.
    void agentSetupPrompt.run();
  }
}

export function deactivate(): Promise<void> | undefined {
  const runtime = terminalSnapshotRuntime;
  terminalSnapshotRuntime = undefined;

  // Returned so VS Code awaits the final save within its shutdown budget;
  // still best-effort — a hard crash never calls deactivate at all.
  return runtime?.save().catch((error) => {
    console.warn('Deck: saving TerminalSnapshot during deactivate failed', error);
  });
}

async function writeDeckConf(
  context: vscode.ExtensionContext,
  tmuxOptions: DeckTmuxOptions = deckTmuxOptionsFromSettings(),
): Promise<string> {
  const templatePath = join(context.extensionPath, 'resources', 'deck.conf');
  const dataDir = deckDataDir();
  const generatedPath = join(dataDir, 'deck.conf');
  const resurrectDir = join(dataDir, 'resurrect');
  const pluginPath = tmuxResurrectPath(context, 'resurrect.tmux');

  const template = await readFile(templatePath, 'utf8');
  // resurrectDir is under dataDir, so this creates both.
  await mkdir(resurrectDir, { recursive: true });
  await writeFile(generatedPath, renderDeckConf(template, { pluginPath, resurrectDir }, tmuxOptions), 'utf8');
  return generatedPath;
}

async function socketExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function deckTmuxOptionsFromSettings(): DeckTmuxOptions {
  const config = vscode.workspace.getConfiguration('deck.tmux');
  return resolveDeckTmuxOptions({
    automaticRenameFormat: config.get<string>('automaticRenameFormat'),
  });
}

function showDeckTmuxOptionWarnings(tmuxOptions: DeckTmuxOptions): void {
  for (const warning of tmuxOptions.warnings) {
    void vscode.window.showWarningMessage(warning);
  }
}

async function applyDeckTmuxOptionsIfServerRunning(
  tmux: TmuxCli,
  tmuxOptions: DeckTmuxOptions,
  tmuxAvailable: boolean,
): Promise<void> {
  try {
    if (!tmuxAvailable || !(await tmux.isServerRunning())) return;

    for (const option of tmuxOptions.options) {
      if (option.value === null) await tmux.unsetOption(option.option);
      else await tmux.setOption(option.option, option.value);
    }
  } catch (error) {
    console.warn('Deck: applying tmux options failed', error);
  }
}

function terminalSnapshotSaveScriptPath(context: vscode.ExtensionContext): string {
  return tmuxResurrectPath(context, 'scripts', 'save.sh');
}

function terminalSnapshotRestoreScriptPath(context: vscode.ExtensionContext): string {
  return tmuxResurrectPath(context, 'scripts', 'restore.sh');
}

function tmuxResurrectPath(context: vscode.ExtensionContext, ...parts: string[]): string {
  return join(context.extensionPath, 'resources', 'plugins', 'tmux-resurrect', ...parts);
}

function terminalSnapshotRestoreFeedback(
  deckDir: string,
  currentTreeView: () => vscode.TreeView<RepositoryTreeNode> | undefined,
): TerminalSnapshotRestoreFeedback {
  return {
    withProgress: async (context, task) => {
      const treeView = currentTreeView();
      if (treeView) treeView.message = 'Restoring terminals…';
      try {
        const copy = formatTerminalSnapshotRestoreProgress({
          unresponsive: context.unresponsive,
          lastSavedAt: await terminalSnapshotLastSaveTime(deckDir),
        });
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: copy.title,
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: copy.message });
            await task();
          },
        );
      } finally {
        if (treeView) treeView.message = undefined;
      }
    },
  };
}

// Deck's machine-global runtime dir, holding the generated DeckSocket conf and
// the TerminalSnapshot. Deliberately NOT globalStorage: the DeckSocket
// (`-L deck`) is one tmux server per user, but globalStorage is per-install
// (VS Code Stable and Insiders would generate competing conf/snapshots for the
// one shared socket) and, on macOS, lives under "~/Library/Application
// Support/…" whose space breaks tmux-resurrect's restore.sh. A space-free
// machine-global dir matches the machine-global socket. Isolated from the
// user's own ~/.local/share/tmux/resurrect.
function deckDataDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'deck');
}

function resumeTemplateFromSettings(): ResumeTemplate {
  const config = vscode.workspace.getConfiguration('deck');
  return new ResumeTemplate({
    claude: config.get<string>('agentResumeTemplates.claude'),
    codex: config.get<string>('agentResumeTemplates.codex'),
  });
}

function agentStatusNotificationEnabled(key: 'notifyOnNeedsInput' | 'notifyOnCompleted'): boolean {
  return vscode.workspace.getConfiguration('deck').get<boolean>(key, true);
}

interface RepositoryRegistryReader {
  list(): readonly string[];
}

async function registeredCommonDirs(
  repositoryRegistry: RepositoryRegistryReader,
  repositoryCommonDirCache: RepositoryCommonDirCache,
): Promise<Set<string>> {
  const commonDirs = await Promise.all(
    repositoryRegistry.list().map((repositoryPath) =>
      resolveCommonDirSafe(repositoryCommonDirCache, repositoryPath),
    ),
  );
  return new Set(commonDirs.filter((commonDir): commonDir is string => commonDir !== null));
}

async function showAgentHookUpgradeNotifications(configs: readonly HookReconcileResult[]): Promise<void> {
  // Unchained: an ignored toast's promise stays pending until dismissed, so a
  // sequential loop could hold back the next agent's toast indefinitely.
  await Promise.all(configs.map(async (config) => {
    const reviewChanges = 'Review Changes';
    const choice = await vscode.window.showInformationMessage(
      `Deck updated its ${agentHookProductName(config.agent)} hooks for this Deck version`,
      reviewChanges,
    );
    if (choice === reviewChanges) await showAgentHookConfigChanges([config]);
  }));
}

async function showAgentHookConfigChanges(configs: readonly AgentConfigChange[]): Promise<void> {
  for (const { agent, configPath } of configs) {
    const current = vscode.Uri.file(configPath);
    const backup = vscode.Uri.file(`${configPath}.deck.bak`);
    const title = `Deck ${agent === 'claude' ? 'Claude' : 'Codex'} hooks (before ↔ after)`;
    try {
      await vscode.workspace.fs.stat(backup);
      await vscode.commands.executeCommand('vscode.diff', backup, current, title);
    } catch {
      // No backup (config was absent before) — just open the new file.
      await vscode.window.showTextDocument(current);
    }
  }
}

function agentHookProductName(agent: HookReconcileResult['agent']): string {
  return agent === 'claude' ? 'Claude Code' : 'Codex';
}

// Mirrors the Explorer's delete confirmation (a modal warning gated by a
// setting). The webview API has no in-dialog "do not ask again" checkbox, so
// `deck.confirmTerminalDelete` carries that effect instead.
async function confirmTerminalRemoval(label: string): Promise<boolean> {
  if (vscode.workspace.getConfiguration('deck').get<boolean>('confirmTerminalDelete', true) === false) {
    return true;
  }
  // Information (not warning) so the dialog has no orange warning icon, matching
  // the Explorer's plain delete confirmation.
  const choice = await vscode.window.showInformationMessage(
    `Are you sure you want to delete the terminal '${label}'?`,
    { modal: true, detail: 'The shell and any running process will be terminated.' },
    'Delete',
  );
  return choice === 'Delete';
}

async function revealActiveTerminalInTree(
  tree: RepositoryTreeProvider,
  treeView: vscode.TreeView<RepositoryTreeNode>,
): Promise<void> {
  const decoded = activeDeckTerminal();
  if (!decoded) return;

  let terminalNode: RepositoryTreeNode | undefined;
  try {
    // findTerminal walks getChildren (a git subprocess) and can fail on a hidden
    // view; this should not surface as an unhandled rejection from a tab event.
    terminalNode = await tree.findTerminal(decoded.sessionName, decoded.worktreePath);
  } catch (error) {
    console.warn('Deck: finding the active terminal failed', error);
    return;
  }
  if (!terminalNode) return;

  const node = terminalNode;
  const revealed = await revealWithRetry(() =>
    treeView.reveal(node, { select: true, focus: false }),
  );
  if (!revealed) console.warn('Deck: revealing the active terminal failed after retries');
}

async function openAgentStatusTerminal(
  tree: RepositoryTreeProvider,
  treeView: vscode.TreeView<RepositoryTreeNode>,
  openTerminal: OpenTerminalCommand,
  sessionName: string,
): Promise<void> {
  try {
    const terminalNode = await tree.findTerminalBySessionName(sessionName);
    if (!terminalNode || !('terminal' in terminalNode)) {
      // Status files are machine-global; this window's tree only shows
      // registered repositories (e.g. another VS Code install owns this one).
      await vscode.window.showInformationMessage(
        "This Terminal's repository isn't registered in this window. Add the repository to Deck to open it.",
      );
      return;
    }
    await openTerminal.run(terminalNode);
    await treeView.reveal(terminalNode, { select: true, focus: false });
  } catch (error) {
    console.warn('Deck: opening agent status Terminal failed', error);
  }
}

function activeDeckTerminal(): { sessionName: string; worktreePath: string } | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = activeTab?.input as { viewType?: unknown; uri?: vscode.Uri } | undefined;
  if (input?.viewType !== terminalEditorViewType || !input.uri) return undefined;

  try {
    return new SessionUriCodec().decode(input.uri);
  } catch {
    return undefined;
  }
}

async function markActiveTerminalRead(
  agentStatuses: Pick<AgentStatusStore, 'markRead'>,
): Promise<void> {
  // Only "read" when you're actually looking: the window must be focused, not
  // merely have the terminal parked as its active tab. Otherwise a completed
  // turn in a background window's active tab would be marked read everywhere
  // (read state is machine-global), clearing the unread dot you never saw.
  if (!vscode.window.state.focused) return;
  const activeTerminal = activeDeckTerminal();
  if (!activeTerminal) return;

  try {
    await agentStatuses.markRead(activeTerminal.sessionName);
  } catch (error) {
    console.warn('Deck: marking active Terminal agent status read failed', error);
  }
}

interface PendingTerminalOpenConsumer {
  consume(worktreePath: string): Promise<string | undefined>;
}

interface TerminalSessionLister {
  listSessions(prefix?: string): Promise<TmuxSession[]>;
}

export async function openPendingTerminalForCurrentWorktree(
  pendingTerminalOpens: PendingTerminalOpenConsumer,
  tmux: TerminalSessionLister,
): Promise<void> {
  const worktreePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!worktreePath) return;

  const sessionName = await pendingTerminalOpens.consume(worktreePath);
  if (!sessionName) return;

  const terminals = await tmux.listSessions(terminalSessionPrefix(worktreePath));
  const terminal = terminals.find((candidate) => candidate.sessionName === sessionName);
  if (!terminal) return;
  const term = terminalSessionNumber(worktreePath, sessionName);
  if (term === 0) return;

  // VS Code natively restores this worktree's terminal tabs in their original
  // groups on switch-back. If the clicked terminal is already a restored tab,
  // reveal it in place — passing ViewColumn.Active would *move* it to the
  // last-focused group. Only a terminal with no tab (session alive, tab closed)
  // opens fresh in the active column.
  const existingColumn = findTerminalTabColumn(sessionName);
  await vscode.commands.executeCommand(
    'vscode.openWith',
    new SessionUriCodec().encode({ worktreePath, term }),
    terminalEditorViewType,
    { viewColumn: existingColumn ?? vscode.ViewColumn.Active },
  );
}

// Scans open tabs (not the provider's panel map, which may not be populated yet
// during post-switch restoration) for a Deck terminal tab matching sessionName.
function findTerminalTabColumn(sessionName: string): vscode.ViewColumn | undefined {
  const codec = new SessionUriCodec();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { viewType?: unknown; uri?: vscode.Uri } | undefined;
      if (input?.viewType !== terminalEditorViewType || !input.uri) continue;
      try {
        if (codec.decode(input.uri).sessionName === sessionName) return group.viewColumn;
      } catch {
        // Not a decodable Deck terminal URI; skip.
      }
    }
  }
  return undefined;
}
