import { Forbidden } from '@agor/core/feathers';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { determineSpawnIdentity } from './branch-authorization';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const SHARED = { branch_id: 'branch-shared', share_owner_home: true };
const NOT_SHARED = { branch_id: 'branch-private', share_owner_home: false };

describe('determineSpawnIdentity', () => {
  it('keeps a same-owner child in the owner genealogy without shared-home audit', () => {
    expect(
      determineSpawnIdentity(
        { created_by: ALICE },
        { user_id: ALICE, role: ROLES.MEMBER },
        NOT_SHARED
      )
    ).toEqual({ created_by: ALICE, usesSharedHome: false });
  });

  it('keeps an explicitly shared cross-user child in the Session owner genealogy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        determineSpawnIdentity({ created_by: BOB }, { user_id: ALICE, role: ROLES.MEMBER }, SHARED)
      ).toEqual({ created_by: BOB, usesSharedHome: true });
      expect(warn).toHaveBeenCalledWith(
        '[SECURITY] personal_session_sharing',
        expect.objectContaining({
          event: 'personal_session_sharing',
          caller_id: ALICE,
          session_owner_id: BOB,
          branch_id: SHARED.branch_id,
        })
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.each([ROLES.MEMBER, ROLES.ADMIN, ROLES.SUPERADMIN])(
    'rejects a cross-user child without owner-authored sharing for %s',
    (role) => {
      expect(() =>
        determineSpawnIdentity({ created_by: BOB }, { user_id: ALICE, role }, NOT_SHARED)
      ).toThrow('The session owner has not shared their sessions with you.');
    }
  );

  it('preserves parent attribution for trusted service-account work', () => {
    expect(
      determineSpawnIdentity(
        { created_by: BOB },
        { user_id: 'executor-sa', _isServiceAccount: true },
        undefined
      )
    ).toEqual({ created_by: BOB, usesSharedHome: false });
  });

  it('fails closed when a human caller has no identity', () => {
    expect(() =>
      determineSpawnIdentity({ created_by: BOB }, { role: ROLES.MEMBER }, NOT_SHARED)
    ).toThrow(Forbidden);
  });
});
