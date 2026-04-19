/**
 * Tests for `determineSpawnIdentity` — the pure helper that decides the
 * `created_by` identity stamped on a child session created via spawn / fork
 * (sessions service: spawn() / fork(), MCP tools agor_sessions_spawn /
 * agor_sessions_prompt(mode:"fork"|"subsession")).
 *
 * The default behavior MUST be "attribute child to caller" so that user A
 * spawning from user B's session does NOT inherit user B's Unix identity,
 * credentials, or env vars. The legacy parent-inheriting "identity borrowing"
 * is gated behind the worktree opt-in `dangerously_allow_session_sharing`.
 */

import { Forbidden } from '@agor/core/feathers';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { determineSpawnIdentity } from './worktree-authorization';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const ADMIN = 'user-admin';
const SUPER = 'user-super';
const WT_FLAG_OFF = { worktree_id: 'wt-off', dangerously_allow_session_sharing: false };
const WT_FLAG_ON = { worktree_id: 'wt-on', dangerously_allow_session_sharing: true };
const WT_UNSET = { worktree_id: 'wt-unset' };

describe('determineSpawnIdentity', () => {
  it('flag disabled: cross-user spawn (Alice spawns from Bob) attributes child to Alice', () => {
    const result = determineSpawnIdentity(
      { created_by: BOB },
      { user_id: ALICE, role: ROLES.MEMBER },
      WT_FLAG_OFF
    );
    expect(result.created_by).toBe(ALICE);
    expect(result.usedLegacySharing).toBe(false);
  });

  it('flag unset (undefined): cross-user spawn attributes child to caller', () => {
    const result = determineSpawnIdentity(
      { created_by: BOB },
      { user_id: ALICE, role: ROLES.MEMBER },
      WT_UNSET
    );
    expect(result.created_by).toBe(ALICE);
    expect(result.usedLegacySharing).toBe(false);
  });

  it('flag disabled: cross-user fork attributes child to caller (same as spawn)', () => {
    // Fork and spawn use the same helper — exercise it through the fork path
    // by passing a fork-shaped scenario.
    const result = determineSpawnIdentity(
      { created_by: BOB },
      { user_id: ALICE, role: ROLES.MEMBER },
      WT_FLAG_OFF
    );
    expect(result.created_by).toBe(ALICE);
  });

  it('flag enabled: same-user spawn attributes child to caller (no legacy path)', () => {
    const result = determineSpawnIdentity(
      { created_by: ALICE },
      { user_id: ALICE, role: ROLES.MEMBER },
      WT_FLAG_ON
    );
    expect(result.created_by).toBe(ALICE);
    expect(result.usedLegacySharing).toBe(false);
  });

  it('flag enabled: cross-user spawn preserves parent identity AND warns (legacy borrowing)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = determineSpawnIdentity(
        { created_by: BOB },
        { user_id: ALICE, role: ROLES.MEMBER },
        WT_FLAG_ON
      );
      expect(result.created_by).toBe(BOB); // child runs under parent owner's identity
      expect(result.usedLegacySharing).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [tag, fields] = warnSpy.mock.calls[0];
      expect(String(tag)).toContain('[SECURITY]');
      expect(fields).toMatchObject({
        event: 'legacy_session_sharing',
        caller_id: ALICE,
        parent_owner_id: BOB,
        worktree_id: 'wt-on',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('admin spawn of any user’s session attributes child to admin (flag-off)', () => {
    const result = determineSpawnIdentity(
      { created_by: BOB },
      { user_id: ADMIN, role: ROLES.ADMIN },
      WT_FLAG_OFF
    );
    expect(result.created_by).toBe(ADMIN);
    expect(result.usedLegacySharing).toBe(false);
  });

  it('admin spawn ignores flag-on opt-in: still attributed to admin', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = determineSpawnIdentity(
        { created_by: BOB },
        { user_id: ADMIN, role: ROLES.ADMIN },
        WT_FLAG_ON
      );
      expect(result.created_by).toBe(ADMIN);
      expect(result.usedLegacySharing).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('superadmin is treated like admin (attributed to self)', () => {
    const result = determineSpawnIdentity(
      { created_by: BOB },
      { user_id: SUPER, role: ROLES.SUPERADMIN },
      WT_FLAG_OFF
    );
    expect(result.created_by).toBe(SUPER);
  });

  it('allowSuperadmin=false demotes superadmin to regular user (caller-as-owner)', () => {
    const result = determineSpawnIdentity(
      { created_by: BOB },
      { user_id: SUPER, role: ROLES.SUPERADMIN },
      WT_FLAG_OFF,
      { allowSuperadmin: false }
    );
    // Without superadmin powers, falls into the "non-admin caller" branch
    // and the safe default still attributes to caller.
    expect(result.created_by).toBe(SUPER);
  });

  it('service accounts preserve parent attribution (no human caller)', () => {
    const result = determineSpawnIdentity(
      { created_by: BOB },
      { user_id: 'executor-sa', _isServiceAccount: true },
      WT_FLAG_OFF
    );
    expect(result.created_by).toBe(BOB);
  });

  it('throws Forbidden when no caller id is available and flag is off', () => {
    expect(() =>
      determineSpawnIdentity(
        { created_by: BOB },
        { role: ROLES.MEMBER }, // no user_id
        WT_FLAG_OFF
      )
    ).toThrow(Forbidden);
  });

  it('falls back safely when worktree is undefined (treated as flag-off)', () => {
    const result = determineSpawnIdentity(
      { created_by: BOB },
      { user_id: ALICE, role: ROLES.MEMBER },
      undefined
    );
    expect(result.created_by).toBe(ALICE);
    expect(result.usedLegacySharing).toBe(false);
  });
});
