import { describe, expect, it, vi } from 'vitest';
import { ensureTeammateWelcomeNote } from './teammateWelcomeNote';

describe('ensureTeammateWelcomeNote', () => {
  it('delegates welcome-note rendering to the boards service', async () => {
    const boardsService = {
      ensureTeammateWelcomeNote: vi.fn().mockResolvedValue({}),
    };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        throw new Error(`Unexpected service: ${name}`);
      }),
    };

    await ensureTeammateWelcomeNote({
      client: client as never,
      boardId: 'board-1',
      teammateName: 'Product/Design Agor Board',
      teammateEmoji: '🧋',
    });

    expect(boardsService.ensureTeammateWelcomeNote).toHaveBeenCalledWith({
      boardId: 'board-1',
      teammateName: 'Product/Design Agor Board',
      teammateEmoji: '🧋',
    });
  });

  it('is best-effort when the daemon-side call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boardsService = {
      ensureTeammateWelcomeNote: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const client = {
      service: vi.fn(() => boardsService),
    };

    await expect(
      ensureTeammateWelcomeNote({
        client: client as never,
        boardId: 'board-1',
        teammateName: 'Helper',
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Failed to create teammate welcome note:', expect.any(Error));
    warn.mockRestore();
  });
});
