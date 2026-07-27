import type { DeckSection } from '../section/sectionStore';

// A pull request shown under a worktree row.
export interface BoardPr {
  number: number;
  title: string;
  url: string;
  needs?: string;
}

// A worktree/session row in the board.
export interface BoardWorktree {
  path: string;
  label: string;
  // Agent status: 'busy' | 'idle' | 'shell' | 'gone' | '' (unknown).
  status: string;
  prs: BoardPr[];
}

// A section header plus the worktrees filed under it.
export interface BoardSection {
  id: string;
  name: string;
  isDefault: boolean;
  count: number;
  worktrees: BoardWorktree[];
}

export interface DeckBoard {
  sections: BoardSection[];
}

// The pseudo-section id for worktrees not assigned to a user section.
export const DEFAULT_SECTION_ID = '';
export const DEFAULT_SECTION_NAME = 'Ungrouped';

// Groups worktrees under their sections. Every user section is emitted (even
// empty ones, so they remain drop targets); an "Ungrouped" section is appended
// only when some worktree is unassigned or its stored section no longer exists.
export function groupIntoSections(
  sections: readonly DeckSection[],
  worktrees: readonly BoardWorktree[],
  sectionOf: (worktreePath: string) => string | undefined,
): BoardSection[] {
  const known = new Set(sections.map((section) => section.id));
  const effectiveId = (worktreePath: string): string => {
    const id = sectionOf(worktreePath);
    return id && known.has(id) ? id : DEFAULT_SECTION_ID;
  };
  const byId = new Map<string, BoardWorktree[]>();
  for (const section of sections) byId.set(section.id, []);
  const ungrouped: BoardWorktree[] = [];
  for (const worktree of worktrees) {
    const id = effectiveId(worktree.path);
    if (id === DEFAULT_SECTION_ID) ungrouped.push(worktree);
    else byId.get(id)?.push(worktree);
  }
  const result: BoardSection[] = sections.map((section) => ({
    id: section.id,
    name: section.name,
    isDefault: false,
    count: byId.get(section.id)?.length ?? 0,
    worktrees: byId.get(section.id) ?? [],
  }));
  if (ungrouped.length) {
    result.push({
      id: DEFAULT_SECTION_ID,
      name: DEFAULT_SECTION_NAME,
      isDefault: true,
      count: ungrouped.length,
      worktrees: ungrouped,
    });
  }
  return result;
}
