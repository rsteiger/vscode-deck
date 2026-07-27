import { describe, expect, it } from 'vitest';
import {
  describeRepositoryTreeItem,
  describeTerminalTreeItem,
  describeWorktreeTreeItem,
} from '../src/tree/worktreeTreeItem';

describe('describeRepositoryTreeItem', () => {
  it('marks the repository matching the open workspace folder common dir as active', () => {
    expect(describeRepositoryTreeItem('/work/alpha', true)).toEqual({
      label: 'alpha',
      description: 'active',
    });

    expect(describeRepositoryTreeItem('/work/beta', false)).toEqual({
      label: 'beta',
      description: '',
    });
  });

  it('does not render agent status rollups in the repository description', () => {
    expect(describeRepositoryTreeItem('/work/alpha', false).description).toBe('');
    expect(describeRepositoryTreeItem('/work/alpha', true).description).toBe('active');
  });
});

describe('describeWorktreeTreeItem', () => {
  it('marks active and main worktree rows with delete-scoping context values', () => {
    const worktrees = [
      {
        path: '/work/alpha-main',
        head: 'a',
        bare: false,
        detached: false,
        branch: 'main',
      },
      {
        path: '/work/alpha-feature',
        head: 'b',
        bare: false,
        detached: false,
        branch: 'feature',
      },
    ];

    expect(
      worktrees.map((worktree) =>
        describeWorktreeTreeItem(worktree, worktree.path === '/work/alpha-main', '/work/alpha-feature'),
      ),
    ).toEqual([
      {
        label: 'main',
        description: 'active',
        tooltip: '/work/alpha-main',
        contextValue: 'deck.worktree.active',
      },
      {
        label: 'feature',
        description: '',
        tooltip: '/work/alpha-feature',
        contextValue: 'deck.worktree.main',
      },
    ]);

    expect(
      describeWorktreeTreeItem(worktrees[0], true, '/work/alpha-main')
        .contextValue,
    ).toBe('deck.worktree.active');
    expect(
      describeWorktreeTreeItem(worktrees[1], false, '/work/other')
        .contextValue,
    ).toBe('deck.worktree');
  });

  it('does not render agent status rollups in the worktree description', () => {
    const worktree = {
      path: '/work/alpha-feature',
      head: 'b',
      bare: false,
      detached: false,
      branch: 'feature',
    };

    expect(describeWorktreeTreeItem(worktree, false, '/work/alpha-main').description)
      .toBe('');
  });

  it('prefers the Claude session name over the branch for the label', () => {
    const worktree = {
      path: '/work/alpha-feature',
      head: 'b',
      bare: false,
      detached: false,
      branch: 'feature',
    };

    expect(describeWorktreeTreeItem(worktree, false, '/work/alpha-main', 'Fix CI').label)
      .toBe('Fix CI');
    // Falls back to the branch when no session name is supplied.
    expect(describeWorktreeTreeItem(worktree, false, '/work/alpha-main').label)
      .toBe('feature');
  });

  it('labels an active detached worktree by folder and shows the short commit in the tooltip', () => {
    const worktree = {
      path: '/work/alpha-origin-fix',
      head: 'abcdef1234567890',
      bare: false,
      detached: true,
    };

    expect(describeWorktreeTreeItem(worktree, true, '/work/alpha-main')).toEqual({
      label: 'alpha-origin-fix',
      description: 'active',
      tooltip: '/work/alpha-origin-fix\nDetached HEAD · abcdef1',
      contextValue: 'deck.worktree.active',
    });
  });

  it('omits the detached commit separator when HEAD is unknown', () => {
    const worktree = {
      path: '/work/alpha-detached',
      head: '',
      bare: false,
      detached: true,
    };

    expect(describeWorktreeTreeItem(worktree, false, '/work/alpha-main').tooltip)
      .toBe('/work/alpha-detached\nDetached HEAD');
  });
});

describe('describeTerminalTreeItem', () => {
  it('renders an agent row label from the glyph-stripped AgentTitle', () => {
    expect(describeTerminalTreeItem('claude', false, undefined, '⠂ reconcile checkout state')).toEqual({
      label: 'reconcile checkout state',
      iconId: 'agent',
      contextValue: 'deck.terminal.foreign',
    });
  });

  it('renders the agent icon from explicit identity for a sidecar-only agent (no status) with a volatile window name', () => {
    expect(describeTerminalTreeItem(
      '2.1.172',
      false,
      undefined,
      '✳ tracking-service-grpc-gateway-pivot',
      'claude',
    )).toEqual({
      label: 'tracking-service-grpc-gateway-pivot',
      iconId: 'agent',
      contextValue: 'deck.terminal.foreign',
    });
  });

  it('renders a known agent row label from AgentTitle when the window name is a volatile process name', () => {
    expect(describeTerminalTreeItem(
      '2.1.172',
      false,
      { status: 'completed', statusAt: 1710000000, agent: 'claude' },
      '✳ tracking-service-grpc-gateway-pivot',
    )).toEqual({
      label: 'tracking-service-grpc-gateway-pivot',
      iconId: 'agent',
      contextValue: 'deck.terminal.foreign',
    });
  });

  it('renders in-progress agent status as a loading row without inline status text', () => {
    expect(describeTerminalTreeItem('claude', false, { status: 'inProgress', statusAt: 1710000000 })).toEqual({
      label: 'claude',
      iconId: 'agent-working',
      contextValue: 'deck.terminal.foreign',
    });
  });

  it('renders non-working agent statuses with the agent identity glyph', () => {
    expect(describeTerminalTreeItem('claude', false, { status: 'needsInput', statusAt: 1710000000 })).toEqual({
      label: 'claude',
      iconId: 'agent',
      contextValue: 'deck.terminal.foreign',
    });
    expect(describeTerminalTreeItem('claude', false, {
      status: 'completed',
      statusAt: 1710000000,
      unread: true,
    })).toEqual({
      label: 'claude',
      iconId: 'agent',
      contextValue: 'deck.terminal.foreign',
    });
    expect(describeTerminalTreeItem('claude', false, {
      status: 'completed',
      statusAt: 1710000000,
      unread: false,
    })).toEqual({
      label: 'claude',
      iconId: 'agent',
      contextValue: 'deck.terminal.foreign',
    });
    expect(describeTerminalTreeItem('claude', false, { status: 'failed', statusAt: 1710000000 })).toEqual({
      label: 'claude',
      iconId: 'agent',
      contextValue: 'deck.terminal.foreign',
    });
  });

  it('shows the agent identity glyph for a claude window with no status yet (resumed/idle)', () => {
    expect(describeTerminalTreeItem('claude', false, undefined)).toEqual({
      label: 'claude',
      iconId: 'agent',
      contextValue: 'deck.terminal.foreign',
    });
  });

  it('shows the agent identity glyph for a codex window with no status yet', () => {
    expect(describeTerminalTreeItem('codex', false, undefined)).toEqual({
      label: 'codex',
      iconId: 'agent',
      contextValue: 'deck.terminal.foreign',
    });
  });

  it('shows the plain terminal icon for a non-agent window', () => {
    expect(describeTerminalTreeItem('zsh', false, undefined)).toEqual({
      label: 'zsh',
      iconId: 'terminal',
      contextValue: 'deck.terminal.foreign',
    });
  });
});
