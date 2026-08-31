import { describe, expect, it } from 'vitest';
import {
  EFFECTIVE_ACCESS_SUBJECTS,
  OVERRIDDEN_BRANCH_FIXTURE,
  PROTOTYPE_PRINCIPALS,
  PROTOTYPE_USERS,
  SHARED_BOARD_FIXTURE,
} from '@/pages/rbac-policy-prototype/fixtures';
import { resolveEffectiveAccessPreview } from './effectiveAccessPreviewModel';

const subject = (userId: string) => {
  const found = EFFECTIVE_ACCESS_SUBJECTS.find(
    (candidate) => candidate.user.principal.user_id === userId
  );
  if (!found) throw new Error(`Missing subject ${userId}`);
  return found;
};

describe('prototype effective-access explanation', () => {
  it('uses a direct user entry as a complete override of matching groups', () => {
    const result = resolveEffectiveAccessPreview({
      policy: SHARED_BOARD_FIXTURE.branch_template.access,
      primaryOwnerUserId: PROTOTYPE_USERS.leo,
      subject: subject(PROTOTYPE_USERS.kasia),
      principals: PROTOTYPE_PRINCIPALS,
    });

    expect(result.sources.map((source) => source.label)).toEqual(['Kasia D.']);
    expect(result.fsAccess).toBe('write');
    expect(result.capabilities).toEqual(
      expect.arrayContaining([
        'sessions.create',
        'sessions.prompt_own',
        'sessions.manage_others',
        'terminal.open',
        'branch.policy.manage',
      ])
    );
  });

  it('unions every matching group when no direct user entry exists', () => {
    const policy = structuredClone(SHARED_BOARD_FIXTURE.branch_template.access);
    policy.entries = policy.entries.filter(
      (entry) =>
        entry.principal.principal_type !== 'user' ||
        entry.principal.user_id !== PROTOTYPE_USERS.kasia
    );
    const result = resolveEffectiveAccessPreview({
      policy,
      primaryOwnerUserId: PROTOTYPE_USERS.leo,
      subject: subject(PROTOTYPE_USERS.kasia),
      principals: PROTOTYPE_PRINCIPALS,
    });

    expect(result.sources.map((source) => source.label)).toEqual(
      expect.arrayContaining(['Product Design', 'Release Engineers'])
    );
    expect(result.capabilities).toEqual(
      expect.arrayContaining(['sessions.prompt_own', 'terminal.open'])
    );
    expect(result.fsAccess).toBe('read');
  });

  it('uses Others only for an unmatched active same-tenant fixture member', () => {
    const result = resolveEffectiveAccessPreview({
      policy: SHARED_BOARD_FIXTURE.branch_template.access,
      primaryOwnerUserId: PROTOTYPE_USERS.leo,
      subject: subject(PROTOTYPE_USERS.omar),
      principals: PROTOTYPE_PRINCIPALS,
    });

    expect(result.usedOthers).toBe(true);
    expect(result.sources.map((source) => source.kind)).toEqual(['others']);
    expect(result.capabilities).toEqual(['branch.view']);
  });

  it('makes a Manager-only group match cumulative with own-session work', () => {
    const result = resolveEffectiveAccessPreview({
      policy: OVERRIDDEN_BRANCH_FIXTURE.override_config!.access,
      primaryOwnerUserId: PROTOTYPE_USERS.leo,
      subject: subject(PROTOTYPE_USERS.nina),
      principals: PROTOTYPE_PRINCIPALS,
    });

    expect(result.sources.map((source) => source.label)).toEqual(['Security']);
    expect(result.capabilities).toEqual(
      expect.arrayContaining([
        'sessions.create',
        'sessions.prompt_own',
        'terminal.open',
        'branch.policy.manage',
      ])
    );
  });

  it('denies inactive and deleted fixture identities before fallback evaluation', () => {
    for (const userId of [PROTOTYPE_USERS.mia, PROTOTYPE_USERS.deleted]) {
      const result = resolveEffectiveAccessPreview({
        policy: SHARED_BOARD_FIXTURE.branch_template.access,
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
