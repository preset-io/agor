import { Forbidden } from '@agor/core/feathers';
import { ROLES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { determineSpawnIdentity } from './branch-authorization';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const NOT_SHARED = { allow_caller_identity: false };
const BRANCH_SCOPED = { allow_caller_identity: true };

describe('determineSpawnIdentity', () => {
  it('keeps a same-owner child in the owner genealogy without shared-home audit', () => {
    expect(
      determineSpawnIdentity(
        { created_by: ALICE },
        { user_id: ALICE, role: ROLES.MEMBER },
        NOT_SHARED
      )
    ).toEqual({ created_by: ALICE });
  });

  it('attributes a branch-scoped cross-user child to the caller', () => {
    expect(
      determineSpawnIdentity(
        { created_by: BOB },
        { user_id: ALICE, role: ROLES.MEMBER },
        BRANCH_SCOPED
      )
    ).toEqual({ created_by: ALICE });
  });

  it.each([ROLES.MEMBER, ROLES.ADMIN, ROLES.SUPERADMIN])(
    'rejects a cross-user child without branch session sharing for %s',
    (role) => {
      expect(() =>
        determineSpawnIdentity({ created_by: BOB }, { user_id: ALICE, role }, NOT_SHARED)
      ).toThrow('This branch does not allow shared session prompting.');
    }
  );

  it('preserves parent attribution for trusted service-account work', () => {
    expect(
      determineSpawnIdentity(
        { created_by: BOB },
        { user_id: 'executor-sa', _isServiceAccount: true },
        undefined
      )
    ).toEqual({ created_by: BOB });
  });

  it('fails closed when a human caller has no identity', () => {
    expect(() =>
      determineSpawnIdentity({ created_by: BOB }, { role: ROLES.MEMBER }, NOT_SHARED)
    ).toThrow(Forbidden);
  });
});
