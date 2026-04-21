/**
 * Tests for `resolveChildUnixUsername` — the pure helper that decides the
 * `unix_username` stamped on a child session created via fork() / spawn().
 *
 * Behavior must stay aligned with {@link determineSpawnIdentity}:
 * - Legacy sharing (worktree opt-in `dangerously_allow_session_sharing`)
 *   inherits `parent.unix_username` (identity borrowing by design).
 * - Default path (same-user forks and cross-user spawns without opt-in)
 *   uses the CALLER's current `unix_username`. We must NOT inherit
 *   `parent.unix_username` on same-user forks, because the user's
 *   unix_username may have drifted since the parent was created, and
 *   `validateSessionUnixUsername` would then reject every prompt.
 */

import { describe, expect, it } from 'vitest';
import { resolveChildUnixUsername } from './worktree-authorization';

describe('resolveChildUnixUsername', () => {
  it('legacy sharing: inherits parent.unix_username (identity borrowing)', () => {
    expect(resolveChildUnixUsername('alice-unix', 'bob-unix', true)).toBe('alice-unix');
  });

  it('legacy sharing with null parent.unix_username returns null', () => {
    expect(resolveChildUnixUsername(null, 'bob-unix', true)).toBeNull();
  });

  it('legacy sharing with undefined parent.unix_username normalizes to null', () => {
    expect(resolveChildUnixUsername(undefined, 'bob-unix', true)).toBeNull();
  });

  it('non-legacy (same-user fork): uses caller current unix_username, NOT parent stale value', () => {
    // Regression guard: same-user fork must NOT fall back to parent.unix_username.
    // If the user's unix_username drifted after the parent was created, we want
    // the CURRENT value so validateSessionUnixUsername later accepts prompts.
    expect(resolveChildUnixUsername('alice-old-unix', 'alice-new-unix', false)).toBe(
      'alice-new-unix'
    );
  });

  it('non-legacy (cross-user, flag off): uses caller current unix_username', () => {
    // Cross-user spawn without legacy opt-in → attributed to caller, so stamp
    // caller's unix_username. Parent's value is irrelevant.
    expect(resolveChildUnixUsername('bob-unix', 'alice-unix', false)).toBe('alice-unix');
  });

  it('non-legacy with null caller unix_username returns null', () => {
    // Caller has no unix_username set → null is a valid stamp in non-strict modes.
    expect(resolveChildUnixUsername('alice-unix', null, false)).toBeNull();
  });

  it('non-legacy with null caller AND null parent returns null', () => {
    expect(resolveChildUnixUsername(null, null, false)).toBeNull();
  });
});
