import type { Board, Branch, Repo } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEAMMATE_EMOJI, sameName, teammateOption } from './teammateLabels';

function teammate(displayName: string, overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'branch-1',
    repo_id: 'repo-1',
    name: 'branch-name',
    board_id: 'board-1',
    custom_context: { teammate: { kind: 'teammate', displayName } },
    ...overrides,
  } as unknown as Branch;
}

const repoById = new Map([['repo-1', { repo_id: 'repo-1', slug: 'preset-io/agor' } as Repo]]);
const boards = (name: string, icon = '📋') =>
  new Map([['board-1', { board_id: 'board-1', name, icon } as Board]]);

describe('sameName', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(sameName('Hodor!', 'hodor')).toBe(true);
    expect(sameName('Mr. Robot', 'mr robot')).toBe(true);
    expect(sameName('Ada', 'Grace')).toBe(false);
  });

  it('compares names without letters or digits as written', () => {
    expect(sameName('🎨', '🚀')).toBe(false);
    expect(sameName('🎨', '🎨')).toBe(true);
  });
});

describe('teammateOption', () => {
  it("hides the board when it is just the teammate's name", () => {
    const option = teammateOption(teammate('Hodor'), boards('hodor!'), repoById);
    expect(option.context).toBeUndefined();
    expect(option.label).toBe('Hodor');
  });

  it('shows a differently named board, and keeps emoji-only names apart', () => {
    expect(teammateOption(teammate('Ada'), boards('Research'), repoById).context).toBe(
      '📋 Research'
    );
    expect(teammateOption(teammate('🎨'), boards('🚀'), repoById).context).toBe('📋 🚀');
  });

  it('falls back to the repo slug without a known board, and to the default emoji', () => {
    const option = teammateOption(teammate('Ada'), new Map(), repoById);
    expect(option.context).toBe('preset-io/agor');
    expect(option.emoji).toBe(DEFAULT_TEAMMATE_EMOJI);
    expect(option.searchText).toContain('preset-io/agor');
  });
});
