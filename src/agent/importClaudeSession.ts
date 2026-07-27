import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  createAndOpenTerminal,
  type AddTerminalTmuxCli,
  type WorktreeNodeLike,
} from '../terminal/addTerminalCommand';
import { SessionUriCodec } from '../terminal/sessionUriCodec';
import { ResumeTemplate } from './resumeTemplate';

interface ImportTmuxCli extends AddTerminalTmuxCli {
  sendCommandLine(session: string, command: string): Promise<void>;
}

export interface ClaudeSessionRecord {
  sessionId: string;
  name: string;
  cwd: string;
  live: boolean;
}

/** Claude Code sessions known to this machine, from ~/.claude/sessions. */
export function readClaudeSessions(
  sessionsDir = path.join(os.homedir(), '.claude', 'sessions'),
): ClaudeSessionRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const byId = new Map<string, ClaudeSessionRecord>();
  for (const file of files) {
    let raw: {
      sessionId?: string;
      name?: string;
      cwd?: string;
      pid?: number;
      updatedAt?: number;
    };
    try {
      raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!raw.sessionId) continue;
    const live = raw.pid !== undefined && fs.existsSync(`/proc/${raw.pid}`);
    const record: ClaudeSessionRecord = {
      sessionId: raw.sessionId,
      name: raw.name || raw.sessionId.slice(0, 8),
      cwd: raw.cwd || os.homedir(),
      live,
    };
    const existing = byId.get(raw.sessionId);
    if (!existing || (record.live && !existing.live)) byId.set(raw.sessionId, record);
  }
  return [...byId.values()];
}

/** Map each session's cwd to its name (live sessions win) for tree labels. */
export function claudeSessionNamesByCwd(
  read: () => ClaudeSessionRecord[] = readClaudeSessions,
): Map<string, string> {
  const byCwd = new Map<string, { name: string; live: boolean }>();
  for (const record of read()) {
    const existing = byCwd.get(record.cwd);
    if (!existing || (record.live && !existing.live)) {
      byCwd.set(record.cwd, { name: record.name, live: record.live });
    }
  }
  return new Map([...byCwd].map(([cwd, { name }]) => [cwd, name]));
}

type SessionQuickPickItem = vscode.QuickPickItem & { record: ClaudeSessionRecord };

/**
 * Resume an existing Claude Code session inside a Deck terminal.
 *
 * Live sessions cannot be adopted — a session's transcript must have a single
 * writing process — so they are shown but refuse to import until exited in
 * their current terminal.
 */
export class ImportClaudeSessionCommand {
  private readonly refresh: () => void;
  private readonly beforeCreate: () => Promise<void>;

  constructor(
    private readonly tmux: ImportTmuxCli,
    options: {
      refresh?: () => void;
      beforeCreate?: () => Promise<void>;
      sessionUriCodec?: SessionUriCodec;
      readSessions?: () => ClaudeSessionRecord[];
    } = {},
  ) {
    this.refresh = options.refresh ?? (() => undefined);
    this.beforeCreate = options.beforeCreate ?? (() => Promise.resolve());
    this.sessionUriCodec = options.sessionUriCodec ?? new SessionUriCodec();
    this.readSessions = options.readSessions ?? readClaudeSessions;
  }

  private readonly sessionUriCodec: SessionUriCodec;
  private readonly readSessions: () => ClaudeSessionRecord[];

  async run(node: WorktreeNodeLike | undefined): Promise<void> {
    if (!node) return;
    const worktreePath = node.worktree.path;
    const sessions = this.readSessions().sort((a, b) => {
      const aIn = a.cwd.startsWith(worktreePath) ? 0 : 1;
      const bIn = b.cwd.startsWith(worktreePath) ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;
      return a.name.localeCompare(b.name);
    });
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No Claude Code sessions found on this machine.');
      return;
    }
    const items: SessionQuickPickItem[] = sessions.map((record) => ({
      label: `${record.live ? '$(circle-filled) ' : '$(debug-restart) '}${record.name}`,
      description: record.live ? 'live — exit it in its current terminal first' : 'resume here',
      detail: `${record.cwd}  ·  ${record.sessionId.slice(0, 8)}`,
      record,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Claude Code session to resume in a Deck Terminal',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if (picked.record.live) {
      vscode.window.showWarningMessage(
        `"${picked.record.name}" is still running in its original terminal. ` +
          'Exit it there first (a transcript can only have one writer), then import it again.',
      );
      return;
    }
    const template = new ResumeTemplate({
      claude: vscode.workspace
        .getConfiguration('deck')
        .get<string>('agentResumeTemplates.claude'),
    });
    const resume = template.render('claude', picked.record.sessionId);
    // Resume from the session's own cwd — Claude Code keys transcripts by
    // project directory, so resuming elsewhere would miss the session.
    const command =
      picked.record.cwd === worktreePath
        ? resume
        : `cd ${JSON.stringify(picked.record.cwd)} && ${resume}`;
    await this.beforeCreate();
    const session = await createAndOpenTerminal(this.tmux, node, this.sessionUriCodec);
    await this.tmux.sendCommandLine(session, command);
    this.refresh();
  }
}
