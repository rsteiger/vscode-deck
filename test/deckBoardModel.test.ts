import { describe, expect, it } from 'vitest';
import { groupIntoSections, type BoardWorktree } from '../src/webview/deckBoardModel';

function worktree(path: string): BoardWorktree {
  return { path, label: path, status: 'idle', prs: [] };
}

describe('groupIntoSections', () => {
  it('files worktrees under their section and appends Ungrouped for the rest', () => {
    const sections = [
      { id: 'a', name: 'Active' },
      { id: 'b', name: 'Backlog' },
    ];
    const worktrees = [worktree('/w/one'), worktree('/w/two'), worktree('/w/three')];
    const assignment: Record<string, string> = { '/w/one': 'a', '/w/three': 'b' };

    const result = groupIntoSections(sections, worktrees, (p) => assignment[p]);

    expect(
      result.map((s) => ({ name: s.name, count: s.count, paths: s.worktrees.map((w) => w.path) })),
    ).toEqual([
      { name: 'Active', count: 1, paths: ['/w/one'] },
      { name: 'Backlog', count: 1, paths: ['/w/three'] },
      { name: 'Ungrouped', count: 1, paths: ['/w/two'] },
    ]);
  });

  it('keeps empty sections as drop targets and omits Ungrouped when all are assigned', () => {
    const sections = [
      { id: 'a', name: 'Active' },
      { id: 'b', name: 'Backlog' },
    ];
    const result = groupIntoSections(sections, [worktree('/w/one')], () => 'a');

    expect(result.map((s) => s.name)).toEqual(['Active', 'Backlog']);
    expect(result.find((s) => s.name === 'Backlog')?.count).toBe(0);
  });

  it('treats a worktree pointing at a deleted section as ungrouped', () => {
    const result = groupIntoSections(
      [{ id: 'a', name: 'Active' }],
      [worktree('/w/one')],
      () => 'stale-section-id',
    );

    expect(result.map((s) => s.name)).toEqual(['Active', 'Ungrouped']);
    expect(result.find((s) => s.name === 'Ungrouped')?.worktrees).toHaveLength(1);
  });
});
