import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SectionStore } from '../src/section/sectionStore';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sections-'));
  file = path.join(dir, 'sections.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SectionStore', () => {
  it('adds a section and assigns a worktree to it', () => {
    const store = new SectionStore(file);
    const section = store.addSection('Active');

    store.assign('/work/alpha', section.id);

    expect(store.list()).toEqual([{ id: section.id, name: 'Active' }]);
    expect(store.sectionOf('/work/alpha')).toBe(section.id);
    expect(store.sectionOf('/work/unassigned')).toBeUndefined();
  });

  it('persists sections and assignments across instances', () => {
    const first = new SectionStore(file);
    const section = first.addSection('Backlog');
    first.assign('/work/beta', section.id);

    const reloaded = new SectionStore(file);

    expect(reloaded.list()).toEqual([{ id: section.id, name: 'Backlog' }]);
    expect(reloaded.sectionOf('/work/beta')).toBe(section.id);
  });

  it('ungroups an assignment when the section is removed', () => {
    const store = new SectionStore(file);
    const section = store.addSection('Shipping');
    store.assign('/work/gamma', section.id);

    store.removeSection(section.id);

    expect(store.list()).toEqual([]);
    expect(store.sectionOf('/work/gamma')).toBeUndefined();
  });

  it('ungroups a worktree when assigned to the empty section id', () => {
    const store = new SectionStore(file);
    const section = store.addSection('Active');
    store.assign('/work/delta', section.id);

    store.assign('/work/delta', '');

    expect(store.sectionOf('/work/delta')).toBeUndefined();
  });

  it('notifies on change', () => {
    const changes: number[] = [];
    const store = new SectionStore(file, () => changes.push(1));

    store.addSection('Active');

    expect(changes.length).toBe(1);
  });
});
