import { describe, expect, it } from 'vitest';
import {
  OVERRIDDEN_BRANCH_FIXTURE,
  PROTOTYPE_PRINCIPALS,
  PROTOTYPE_SUBJECTS,
  PROTOTYPE_USERS,
  SHARED_BOARD_FIXTURE,
} from '@/pages/rbac-policy-prototype/fixtures';
import { resolvePrototypeEffectiveAccess } from './prototypeEffectiveAccess';

const subject = (userId: string) => {
  const found = PROTOTYPE_SUBJECTS.find((candidate) => candidate.user.principal.user_id === userId);
  if (!found) throw new Error(`Missing subject ${userId}`);
  return found;
};

describe('prototype effective-access explanation', () => {
  it('unions overlapping direct and group entries without Manager adding execution', () => {
    const result = resolvePrototypeEffectiveAccess({
      policy: SHARED_BOARD_FIXTURE.branch_template,
      primaryOwnerUserId: PROTOTYPE_USERS.leo,
      subject: subject(PROTOTYPE_USERS.kasia),
      principals: PROTOTYPE_PRINCIPALS,
    });

    expect(result.sources.map((source) => source.label)).toEqual(
      expect.arrayContaining(['Kasia D.', 'Product Design', 'Release Engineers'])
    );
    expect(result.fsAccess).toBe('write');
    expect(result.capabilities).toEqual(
      expect.arrayContaining(['sessions.prompt_own', 'branch.policy.manage'])
    );
  });

  it('uses Others only for an unmatched active same-tenant fixture member', () => {
    const result = resolvePrototypeEffectiveAccess({
      policy: SHARED_BOARD_FIXTURE.branch_template,
      primaryOwnerUserId: PROTOTYPE_USERS.leo,
      subject: subject(PROTOTYPE_USERS.omar),
      principals: PROTOTYPE_PRINCIPALS,
    });

    expect(result.usedOthers).toBe(true);
    expect(result.sources.map((source) => source.kind)).toEqual(['others']);
    expect(result.capabilities).toEqual(['branch.view']);
  });

  it('keeps a Manager-only group match free of prompt and execution authority', () => {
    const result = resolvePrototypeEffectiveAccess({
      policy: OVERRIDDEN_BRANCH_FIXTURE.override_policy!,
      primaryOwnerUserId: PROTOTYPE_USERS.leo,
      subject: subject(PROTOTYPE_USERS.nina),
      principals: PROTOTYPE_PRINCIPALS,
    });

    expect(result.sources.map((source) => source.label)).toEqual(['Security']);
    expect(result.capabilities).toEqual(expect.arrayContaining(['branch.policy.manage']));
    expect(result.capabilities).not.toEqual(
      expect.arrayContaining(['sessions.create', 'sessions.prompt_own', 'terminal.open'])
    );
  });

  it('denies inactive and deleted fixture identities before fallback evaluation', () => {
    for (const userId of [PROTOTYPE_USERS.mia, PROTOTYPE_USERS.deleted]) {
      const result = resolvePrototypeEffectiveAccess({
        policy: SHARED_BOARD_FIXTURE.branch_template,
        primaryOwnerUserId: PROTOTYPE_USERS.leo,
        subject: subject(userId),
        principals: PROTOTYPE_PRINCIPALS,
      });

      expect(result.capabilities).toEqual([]);
      expect(result.usedOthers).toBe(false);
      expect(result.deniedReason).toBeTruthy();
    }
  });
});
