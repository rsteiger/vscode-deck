import { describe, expect, it, vi } from 'vitest';

// The provider and its HTML only use vscode types at runtime, so an empty mock
// suffices.
vi.mock('vscode', () => ({}));

import { DeckBoardViewProvider, type DeckBoardHandlers } from '../src/webview/deckBoardViewProvider';
import type { DeckBoard } from '../src/webview/deckBoardModel';

function noopHandlers(): DeckBoardHandlers {
  return {
    openWorktree: vi.fn(),
    openPr: vi.fn(),
    assignSection: vi.fn(),
    addSection: vi.fn(),
    renameSection: vi.fn(),
    removeSection: vi.fn(),
  };
}

function fakeView() {
  let messageHandler: (message: unknown) => void = () => {};
  const post = vi.fn();
  const view = {
    webview: {
      options: {},
      html: '',
      postMessage: post,
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        messageHandler = handler;
        return { dispose: vi.fn() };
      },
    },
    onDidDispose: () => ({ dispose: vi.fn() }),
  };
  return { view, post, send: (m: unknown) => messageHandler(m) };
}

const EMPTY_BOARD: DeckBoard = { sections: [] };

describe('DeckBoardViewProvider', () => {
  it('posts the model when the webview reports ready', async () => {
    const board: DeckBoard = { sections: [{ id: 'a', name: 'Active', isDefault: false, count: 0, worktrees: [] }] };
    const provider = new DeckBoardViewProvider(async () => board, noopHandlers());
    const { view, post, send } = fakeView();

    provider.resolveWebviewView(view as never);
    send({ type: 'ready' });
    await Promise.resolve();

    expect(post).toHaveBeenCalledWith({ type: 'model', model: board });
  });

  it('routes user actions to the matching handler', async () => {
    const handlers = noopHandlers();
    const provider = new DeckBoardViewProvider(async () => EMPTY_BOARD, handlers);
    const { view, send } = fakeView();
    provider.resolveWebviewView(view as never);

    send({ type: 'openWorktree', path: '/w/one' });
    send({ type: 'openPr', number: 42, url: 'https://x/42' });
    send({ type: 'assign', path: '/w/one', sectionId: 'a' });
    send({ type: 'renameSection', id: 'a' });
    send({ type: 'removeSection', id: 'a' });

    expect(handlers.openWorktree).toHaveBeenCalledWith('/w/one');
    expect(handlers.openPr).toHaveBeenCalledWith(42, 'https://x/42');
    expect(handlers.assignSection).toHaveBeenCalledWith('/w/one', 'a');
    expect(handlers.renameSection).toHaveBeenCalledWith('a');
    expect(handlers.removeSection).toHaveBeenCalledWith('a');
  });
});
