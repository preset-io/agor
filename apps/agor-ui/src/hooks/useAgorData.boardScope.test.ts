import { describe, expect, it } from 'vitest';
import { resolveDisplayedBoardId } from './useAgorData';

/**
 * `resolveDisplayedBoardId` decides which board the first gated fetch is scoped
 * to. Returning null means a GLOBAL, unscoped first paint — never wrong, but it
 * leaves the displayed board's `objects` undefined until background hydration
 * lands. The mobile routes sit outside `ENTITY_PATH_SEGMENTS` and carry full
 * ids rather than short ids, so they have to be matched explicitly.
 */
// Real ids, because board resolution goes through `findByShortIdPrefix`, which
// only matches hex — placeholder ids like `board-1` silently resolve to null.
const BOARD_1 = '01a012d8-1b9b-7909-b6f4-2024dfc7c51e';
const BOARD_2 = '01a012d8-2c3d-7a10-9e88-4b1c5d6e7f90';
const BRANCH_1 = '01a012d8-3e4f-7b21-8c99-5d2e6f708a1b';
const SESSION_1 = '01a012d8-4f50-7c32-9daa-6e3f70819b2c';
const SESSION_LEGACY = '01a012d8-5061-7d43-aebb-7f4081920c3d';

const boardById = new Map([
  [BOARD_1, { board_id: BOARD_1, slug: 'delivery' }],
  [BOARD_2, { board_id: BOARD_2, slug: 'research' }],
]);

const branchById = new Map([[BRANCH_1, { branch_id: BRANCH_1, board_id: BOARD_2 }]]);

const sessionById = new Map([
  [SESSION_1, { session_id: SESSION_1, branch_id: BRANCH_1, branch_board_id: BOARD_2 }],
  // Predates `branch_board_id`; has to chain through the branch instead.
  [SESSION_LEGACY, { session_id: SESSION_LEGACY, branch_id: BRANCH_1 }],
]);

const resolve = (pathname: string) =>
  resolveDisplayedBoardId(pathname, boardById, branchById, sessionById);

describe('resolveDisplayedBoardId — mobile routes', () => {
  it('scopes a cold /m/board/:boardId load to that board', () => {
    expect(resolve(`/m/board/${BOARD_1}`)).toBe(BOARD_1);
  });

  it('scopes a cold /m/comments/:boardId load to that board', () => {
    expect(resolve(`/m/comments/${BOARD_2}`)).toBe(BOARD_2);
  });

  it('scopes a cold /m/session/:sessionId load to the session own board', () => {
    expect(resolve(`/m/session/${SESSION_1}`)).toBe(BOARD_2);
  });

  it('chains through the branch when the session predates branch_board_id', () => {
    expect(resolve(`/m/session/${SESSION_LEGACY}`)).toBe(BOARD_2);
  });

  it('tolerates the /ui basename', () => {
    expect(resolve(`/ui/m/board/${BOARD_1}`)).toBe(BOARD_1);
  });

  it('falls back to a global first paint for an unknown board', () => {
    expect(resolve('/m/board/01a012d8-9999-7000-8000-000000000000')).toBeNull();
  });

  it('falls back to a global first paint for an unknown session', () => {
    expect(resolve('/m/session/01a012d8-8888-7000-8000-000000000000')).toBeNull();
  });

  it('falls back to a global first paint on the mobile home route', () => {
    expect(resolve('/m/')).toBeNull();
  });
});
