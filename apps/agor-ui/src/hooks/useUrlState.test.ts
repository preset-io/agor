/**
 * Tests for useUrlState's pure URL-resolution helpers.
 *
 * The interesting contract here is the *failure mode*: when a URL prefix
 * matches multiple boards or sessions, we refuse to guess and return null
 * (treating ambiguity as not-found). Previously the hook silently routed
 * to the lexicographically-greatest match — fine for valid 8-char URLs
 * minted at low load, but for legacy bookmarks at ≤16 chars it could
 * silently land on the wrong session. This test fixates that behavior so
 * future refactors don't quietly bring back the silent mis-route.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveBoardFromUrlPure, resolveSessionFromShortIdPure } from './useUrlState';

const boardA = { board_id: '019e3825-0000-7000-8000-000000000001', slug: 'alpha' };
const boardB = { board_id: '019e3825-0000-7000-8000-000000000002', slug: 'beta' };
// Same 8-char prefix as A and B (legacy collision scenario).
const boardC = { board_id: '019e3825-0000-7000-8000-000000000003', slug: 'gamma' };

const sessionA = { session_id: '019e3826-0000-7000-8000-000000000001' };
const sessionB = { session_id: '019e3826-0000-7000-8000-000000000002' };

function boardMap(...boards: (typeof boardA)[]) {
  return new Map(boards.map((b) => [b.board_id, b]));
}
function sessionMap(...sessions: (typeof sessionA)[]) {
  return new Map(sessions.map((s) => [s.session_id, s]));
}

describe('resolveBoardFromUrlPure', () => {
  it('resolves a slug to the matching board id', () => {
    expect(resolveBoardFromUrlPure('alpha', boardMap(boardA, boardB))).toBe(boardA.board_id);
  });

  it('resolves an unambiguous short-id prefix', () => {
    // 12 chars uniquely identifies — different timestamp segments.
    const other = { board_id: '019e3827-0000-7000-8000-000000000099', slug: 'other' };
    expect(resolveBoardFromUrlPure('019e3825', boardMap(boardA, other))).toBe(boardA.board_id);
  });

  it('returns null for a not-found prefix', () => {
    expect(resolveBoardFromUrlPure('deadbeef', boardMap(boardA, boardB))).toBeNull();
  });

  it('refuses to guess on an ambiguous prefix — returns null', () => {
    // 8-char prefix matches all three boards.
    expect(resolveBoardFromUrlPure('019e3825', boardMap(boardA, boardB, boardC))).toBeNull();
  });

  it('fires the onAmbiguous callback with the prefix and match count', () => {
    const onAmbiguous = vi.fn();
    resolveBoardFromUrlPure('019e3825', boardMap(boardA, boardB, boardC), onAmbiguous);
    expect(onAmbiguous).toHaveBeenCalledTimes(1);
    expect(onAmbiguous).toHaveBeenCalledWith('019e3825', 3);
  });

  it('prefers slug match over short-id match when both would match', () => {
    // Slug "019e3825" would also be a valid short-id prefix.
    const slugLikeId = { board_id: '019e3826-0000-7000-8000-000000000099', slug: '019e3825' };
    expect(resolveBoardFromUrlPure('019e3825', boardMap(boardA, slugLikeId))).toBe(
      slugLikeId.board_id
    );
  });
});

describe('resolveSessionFromShortIdPure', () => {
  it('resolves an unambiguous prefix', () => {
    const other = { session_id: '019e3827-0000-7000-8000-000000000099' };
    expect(resolveSessionFromShortIdPure('019e3826', sessionMap(sessionA, other))).toBe(
      sessionA.session_id
    );
  });

  it('returns null for a not-found prefix', () => {
    expect(resolveSessionFromShortIdPure('deadbeef', sessionMap(sessionA, sessionB))).toBeNull();
  });

  it('refuses to guess on an ambiguous prefix — returns null, NOT the newest match', () => {
    // The legacy behavior would have returned sessionB (lex-greatest).
    // Asserting null fixates the new "refuse to guess" contract.
    expect(resolveSessionFromShortIdPure('019e3826', sessionMap(sessionA, sessionB))).toBeNull();
  });

  it('fires the onAmbiguous callback with the prefix and match count', () => {
    const onAmbiguous = vi.fn();
    resolveSessionFromShortIdPure('019e3826', sessionMap(sessionA, sessionB), onAmbiguous);
    expect(onAmbiguous).toHaveBeenCalledTimes(1);
    expect(onAmbiguous).toHaveBeenCalledWith('019e3826', 2);
  });

  it('does NOT call onAmbiguous on unique or not-found inputs', () => {
    const onAmbiguous = vi.fn();
    resolveSessionFromShortIdPure(sessionA.session_id, sessionMap(sessionA), onAmbiguous);
    resolveSessionFromShortIdPure('deadbeef', sessionMap(sessionA), onAmbiguous);
    expect(onAmbiguous).not.toHaveBeenCalled();
  });
});
