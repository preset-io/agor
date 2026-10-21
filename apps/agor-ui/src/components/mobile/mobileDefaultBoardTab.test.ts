import { describe, expect, it } from 'vitest';
import { mobileDefaultBoardTab } from './MobileBoardPage';

describe('mobileDefaultBoardTab', () => {
  it('opens on Board when the board puts Board first', () => {
    expect(mobileDefaultBoardTab({ tab_order: ['board', 'chat', 'files'] })).toBe('board');
  });

  it('opens on the teammate when Chat is first', () => {
    expect(mobileDefaultBoardTab({ tab_order: ['chat', 'board', 'files'] })).toBe('teammate');
  });

  it('keeps today’s teammate default for boards without a stored order', () => {
    expect(mobileDefaultBoardTab({})).toBe('teammate');
    expect(mobileDefaultBoardTab(undefined)).toBe('teammate');
  });
});
