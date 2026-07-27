import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A user-created grouping of worktrees in the Deck tree.
export interface DeckSection {
  id: string;
  name: string;
}

interface SectionState {
  sections: DeckSection[];
  assignments: Record<string, string>;
}

// Persists sections and worktree→section assignments to a JSON file.
//
// code-server does not persist extension globalState (no state.vscdb), so
// section state — which must survive window reloads — lives in a plain file
// under the user's data dir rather than in context.globalState.
export class SectionStore {
  private state: SectionState = { sections: [], assignments: {} };

  constructor(
    private readonly filePath: string = defaultSectionFile(),
    private readonly onChange: () => void = () => {},
  ) {
    this.load();
  }

  list(): DeckSection[] {
    return this.state.sections.map((section) => ({ ...section }));
  }

  // The section a worktree belongs to, or undefined when unassigned or when its
  // section has since been deleted.
  sectionOf(worktreePath: string): string | undefined {
    const id = this.state.assignments[worktreePath];
    if (!id) return undefined;
    return this.state.sections.some((section) => section.id === id) ? id : undefined;
  }

  addSection(name: string): DeckSection {
    const section: DeckSection = { id: crypto.randomUUID(), name };
    this.state.sections.push(section);
    this.persist();
    return section;
  }

  renameSection(id: string, name: string): void {
    const section = this.state.sections.find((candidate) => candidate.id === id);
    if (!section) return;
    section.name = name;
    this.persist();
  }

  removeSection(id: string): void {
    this.state.sections = this.state.sections.filter((section) => section.id !== id);
    for (const [worktreePath, sectionId] of Object.entries(this.state.assignments)) {
      if (sectionId === id) delete this.state.assignments[worktreePath];
    }
    this.persist();
  }

  // Assign a worktree to a section; an empty sectionId ungroups it.
  assign(worktreePath: string, sectionId: string): void {
    if (!sectionId) delete this.state.assignments[worktreePath];
    else this.state.assignments[worktreePath] = sectionId;
    this.persist();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // No state file yet — start empty.
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SectionState>;
      if (Array.isArray(parsed.sections)) {
        this.state = {
          sections: parsed.sections,
          assignments: parsed.assignments ?? {},
        };
      }
    } catch {
      // Corrupt state file — ignore and start empty rather than crash activation.
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch {
      // Best-effort: a write failure should not break tree updates.
    }
    this.onChange();
  }
}

export function defaultSectionFile(): string {
  return path.join(os.homedir(), '.local', 'share', 'deck', 'sections.json');
}
