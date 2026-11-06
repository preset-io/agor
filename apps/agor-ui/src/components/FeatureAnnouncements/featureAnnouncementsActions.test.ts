import type { User } from '@agor-live/client';
import { beforeEach, expect, it } from 'vitest';
import { recentBoardsStorageKey } from '../../hooks/useRecentBoards';
import {
  canOpenAgorPage,
  currentOrRecentBoardId,
  formatReleaseDate,
} from './featureAnnouncementsActions';

const MAIN = '01a17e45-5b1a-71d0-baed-ed27bc25facf';
const RECENT = '01a17e47-4768-7017-92e4-75e003cf4a27';
const user = { user_id: 'user-1', preferences: { mainBoardId: MAIN } } as unknown as User;

beforeEach(() => localStorage.clear());

it('opens the recent board, else the main board', () => {
  expect(currentOrRecentBoardId(user)).toBe(MAIN);
  localStorage.setItem(recentBoardsStorageKey('user-1'), JSON.stringify([RECENT]));
  expect(currentOrRecentBoardId(user)).toBe(RECENT);
  expect(currentOrRecentBoardId({ user_id: 'u2' } as unknown as User)).toBeUndefined();
});

it('reads release dates as calendar days', () => {
  expect(formatReleaseDate('2026-10-28T00:00:00.000Z')).toMatch(/Oct 28/);
});

it('lets each role open only the pages it can use', () => {
  const as = (role: string) => ({ user_id: 'u', role }) as unknown as User;
  expect(canOpenAgorPage('integrations', as('admin'))).toBe(true);
  expect(canOpenAgorPage('integrations', as('member'))).toBe(false);
  expect(canOpenAgorPage('mcp', as('member'))).toBe(true);
  expect(canOpenAgorPage('mcp', as('viewer'))).toBe(false);
  for (const target of ['board', 'teammates', 'models', 'artifacts'] as const) {
    expect(canOpenAgorPage(target, as('viewer'))).toBe(true);
  }
});
