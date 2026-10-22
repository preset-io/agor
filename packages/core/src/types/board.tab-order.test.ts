import { describe, expect, it } from 'vitest';
import { DEFAULT_BOARD_TAB_ORDER, normalizeBoardTabOrder, resolveBoardTabOrder } from './board';

describe('normalizeBoardTabOrder', () => {
  it('falls back to the default order for missing or non-list values', () => {
    expect(normalizeBoardTabOrder(undefined)).toEqual(DEFAULT_BOARD_TAB_ORDER);
    expect(normalizeBoardTabOrder(null)).toEqual(DEFAULT_BOARD_TAB_ORDER);
    expect(normalizeBoardTabOrder('chat')).toEqual(DEFAULT_BOARD_TAB_ORDER);
  });

  it('keeps the stored order, drops unknown keys and duplicates', () => {
    expect(normalizeBoardTabOrder(['files', 'chat', 'board'])).toEqual(['files', 'chat', 'board']);
    expect(normalizeBoardTabOrder(['chat', 'canvas', 'chat', 7, 'files', 'board'])).toEqual([
      'chat',
      'files',
      'board',
    ]);
  });

  it('appends missing views in default order', () => {
    expect(normalizeBoardTabOrder(['chat'])).toEqual(['chat', 'board', 'files']);
    expect(normalizeBoardTabOrder(['files'])).toEqual(['files', 'board', 'chat']);
  });
});

describe('resolveBoardTabOrder', () => {
  it('uses the default when the board has no order', () => {
    expect(resolveBoardTabOrder(null)).toEqual(['board', 'chat', 'files']);
    expect(resolveBoardTabOrder({})).toEqual(['board', 'chat', 'files']);
    expect(resolveBoardTabOrder({ tab_order: ['chat', 'board', 'files'] })).toEqual([
      'chat',
      'board',
      'files',
    ]);
  });
});
