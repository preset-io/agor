import { describe, expect, it, vi } from 'vitest';
import { ensureAssistantWelcomeNote } from './assistantWelcomeNote';

describe('ensureAssistantWelcomeNote', () => {
  it('delegates welcome-note rendering to the boards service', async () => {
    const boardsService = {
      ensureAssistantWelcomeNote: vi.fn().mockResolvedValue({}),
    };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        throw new Error(`Unexpected service: ${name}`);
      }),
    };

    await ensureAssistantWelcomeNote({
      client: client as never,
      boardId: 'board-1',
      assistantName: 'Product/Design Agor Board',
      assistantEmoji: '🧋',
    });

    expect(boardsService.ensureAssistantWelcomeNote).toHaveBeenCalledWith({
      boardId: 'board-1',
      assistantName: 'Product/Design Agor Board',
      assistantEmoji: '🧋',
    });
  });

  it('is best-effort when the daemon-side call fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boardsService = {
      ensureAssistantWelcomeNote: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const client = {
      service: vi.fn(() => boardsService),
    };

    await expect(
      ensureAssistantWelcomeNote({
        client: client as never,
        boardId: 'board-1',
        assistantName: 'Helper',
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Failed to create assistant welcome note:',
      expect.any(Error)
    );
    warn.mockRestore();
  });
});
