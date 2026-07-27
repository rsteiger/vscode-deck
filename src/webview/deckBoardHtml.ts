import * as vscode from 'vscode';

// Renders the board webview HTML. The client script receives {type:'model'}
// messages and paints sections (SCM-style header bars + count badges), worktree
// rows, and PR rows, and posts back user actions (open, assign, section CRUD).
export function deckBoardHtml(webview: vscode.Webview): string {
  const nonce = makeNonce();
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${STYLE}</style>
</head>
<body>
<div id="board"></div>
<div id="empty" class="empty">No active worktrees.</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  user-select: none;
}
.empty { display: none; padding: 12px; color: var(--vscode-descriptionForeground); }
.section { }
.section.drop-target > .shead {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.shead {
  display: flex; align-items: center; gap: 4px;
  height: 22px; padding: 0 6px 0 4px; cursor: pointer;
  background: var(--vscode-sideBarSectionHeader-background);
  color: var(--vscode-sideBarSectionHeader-foreground);
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
  font-weight: 700; font-size: 11px; letter-spacing: 0.04em;
  text-transform: uppercase;
}
.shead:hover { background: var(--vscode-list-hoverBackground); }
.twistie { width: 16px; text-align: center; flex: 0 0 auto; opacity: 0.85; }
.sname { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count {
  flex: 0 0 auto; min-width: 18px; text-align: center;
  padding: 0 6px; border-radius: 10px; font-size: 11px; font-weight: 600;
  text-transform: none; letter-spacing: 0;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.sact {
  flex: 0 0 auto; width: 18px; text-align: center; cursor: pointer;
  opacity: 0; color: var(--vscode-sideBarSectionHeader-foreground);
}
.shead:hover .sact { opacity: 0.7; }
.sact:hover { opacity: 1; }
.sbody { }
.section.collapsed .sbody { display: none; }
.wt {
  display: flex; align-items: center; gap: 6px;
  height: 22px; padding: 0 6px 0 18px; cursor: pointer;
}
.wt:hover { background: var(--vscode-list-hoverBackground); }
.wt.dragging { opacity: 0.5; }
.dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
       background: var(--vscode-descriptionForeground); }
.dot.busy { background: var(--vscode-charts-green, #3fb950); }
.dot.idle { background: var(--vscode-charts-blue, #58a6ff); }
.dot.shell { background: var(--vscode-charts-yellow, #d29922); }
.dot.gone { background: var(--vscode-descriptionForeground); }
.wt .label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr {
  display: flex; align-items: center; gap: 6px;
  height: 20px; padding: 0 6px 0 34px; cursor: pointer;
  color: var(--vscode-descriptionForeground);
}
.pr:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.pr .num { flex: 0 0 auto; color: var(--vscode-gitDecoration-untrackedResourceForeground, #58a6ff); }
.pr .ptitle { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr .needs { flex: 0 0 auto; font-size: 10px; opacity: 0.8; }
.none { padding: 2px 6px 4px 34px; color: var(--vscode-descriptionForeground);
        font-style: italic; font-size: 11px; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const board = document.getElementById('board');
const emptyEl = document.getElementById('empty');
let collapsed = new Set((vscode.getState() || {}).collapsed || []);

function persistCollapse() {
  vscode.setState({ collapsed: [...collapsed] });
}
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function render(model) {
  const sections = (model && model.sections) || [];
  board.replaceChildren();
  const anyWorktrees = sections.some(s => s.worktrees.length);
  emptyEl.style.display = sections.length ? 'none' : 'block';
  for (const section of sections) {
    board.appendChild(renderSection(section));
  }
}

function renderSection(section) {
  const wrap = document.createElement('div');
  wrap.className = 'section';
  const isCollapsed = collapsed.has(section.id);
  if (isCollapsed) wrap.classList.add('collapsed');

  const head = document.createElement('div');
  head.className = 'shead';
  head.innerHTML =
    '<span class="twistie">' + (isCollapsed ? '\\u25B8' : '\\u25BE') + '</span>' +
    '<span class="sname">' + esc(section.name) + '</span>' +
    (section.isDefault ? '' :
      '<span class="sact rename" title="Rename section">\\u270E</span>' +
      '<span class="sact remove" title="Delete section">\\u2715</span>') +
    '<span class="count">' + section.count + '</span>';
  head.addEventListener('click', (e) => {
    if (e.target.classList.contains('sact')) return;
    if (isCollapsed) collapsed.delete(section.id); else collapsed.add(section.id);
    persistCollapse();
    wrap.classList.toggle('collapsed');
    head.querySelector('.twistie').textContent =
      wrap.classList.contains('collapsed') ? '\\u25B8' : '\\u25BE';
  });
  const rename = head.querySelector('.rename');
  if (rename) rename.addEventListener('click', () =>
    vscode.postMessage({ type: 'renameSection', id: section.id }));
  const remove = head.querySelector('.remove');
  if (remove) remove.addEventListener('click', () =>
    vscode.postMessage({ type: 'removeSection', id: section.id }));

  // The whole section is a drop target for worktree rows.
  const setDrop = (on) => wrap.classList.toggle('drop-target', on);
  wrap.addEventListener('dragover', (e) => {
    if (dragPath) { e.preventDefault(); setDrop(true); }
  });
  wrap.addEventListener('dragleave', (e) => {
    if (!wrap.contains(e.relatedTarget)) setDrop(false);
  });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault(); setDrop(false);
    if (dragPath) vscode.postMessage({ type: 'assign', path: dragPath, sectionId: section.id });
  });

  const body = document.createElement('div');
  body.className = 'sbody';
  for (const wt of section.worktrees) body.appendChild(renderWorktree(wt));
  wrap.append(head, body);
  return wrap;
}

let dragPath = null;

function renderWorktree(wt) {
  const frag = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = 'wt';
  row.draggable = true;
  row.innerHTML =
    '<span class="dot ' + esc(wt.status) + '"></span>' +
    '<span class="label" title="' + esc(wt.path) + '">' + esc(wt.label) + '</span>';
  row.addEventListener('click', () =>
    vscode.postMessage({ type: 'openWorktree', path: wt.path }));
  row.addEventListener('dragstart', (e) => {
    dragPath = wt.path; row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => { dragPath = null; row.classList.remove('dragging'); });
  frag.appendChild(row);
  for (const pr of wt.prs) {
    const p = document.createElement('div');
    p.className = 'pr';
    p.innerHTML =
      '<span class="num">#' + pr.number + '</span>' +
      '<span class="ptitle" title="' + esc(pr.title) + '">' + esc(pr.title) + '</span>' +
      (pr.needs ? '<span class="needs">' + esc(pr.needs) + '</span>' : '');
    p.addEventListener('click', () =>
      vscode.postMessage({ type: 'openPr', number: pr.number, url: pr.url }));
    frag.appendChild(p);
  }
  return frag;
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'model') render(e.data.model);
});
vscode.postMessage({ type: 'ready' });
`;

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars[Math.floor(Math.random() * chars.length)];
  }
  return nonce;
}
