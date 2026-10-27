import type { ReleaseNoteDTO, User } from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { beforeEach, expect, it } from 'vitest';
import { recentBoardsStorageKey } from '../../hooks/useRecentBoards';
import { buildAskTeammatePrompt, resolveCtaPath } from './releaseNotesLinks';

const MAIN = '01a17e45-5b1a-71d0-baed-ed27bc25facf';
const RECENT = '01a17e47-4768-7017-92e4-75e003cf4a27';
const user = { user_id: 'user-1', preferences: { mainBoardId: MAIN } } as unknown as User;

beforeEach(() => localStorage.clear());

it('resolves board tokens to the recent or main board', () => {
  expect(resolveCtaPath('/b/:mainBoard/', user)).toBe(`/b/${shortId(MAIN)}/`);
  expect(resolveCtaPath('/b/:currentBoard/', user)).toBe(`/b/${shortId(MAIN)}/`);
  localStorage.setItem(recentBoardsStorageKey('user-1'), JSON.stringify([RECENT]));
  expect(resolveCtaPath('/b/:currentBoard/', user)).toBe(`/b/${shortId(RECENT)}/`);
  expect(resolveCtaPath('/settings', user)).toBe('/settings');
});

it('hides CTAs that leave the app or have no board to open', () => {
  expect(resolveCtaPath('https://evil.example/', user)).toBeNull();
  expect(resolveCtaPath('//evil.example/', user)).toBeNull();
  expect(resolveCtaPath('/b/:mainBoard/', { user_id: 'u2' } as unknown as User)).toBeNull();
  expect(resolveCtaPath(null, user)).toBeNull();
});

it('asks the teammate about each item without changing anything unasked', () => {
  const notes = [
    {
      id: 'r1',
      published_at: '2026-10-20T00:00:00.000Z',
      items: [
        {
          title: 'Zone layouts',
          agent_brief: 'Zones arrange cards.',
          docs_url: 'https://agor.live/guide/boards',
        },
        { title: 'A fix', agent_brief: 'Fixed a thing.', docs_url: null },
      ],
    },
  ] as unknown as ReleaseNoteDTO[];

  const prompt = buildAskTeammatePrompt(notes);
  expect(prompt).toContain(
    '- Zone layouts (2026-10-20): Zones arrange cards. Docs: https://agor.live/guide/boards'
  );
  expect(prompt).toContain('- A fix (2026-10-20): Fixed a thing.');
  expect(prompt).toContain('Do not change anything without asking me first.');
});
