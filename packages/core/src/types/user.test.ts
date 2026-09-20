/**
 * User type utilities tests
 *
 * Tests normalizeRole backwards compatibility for deprecated 'owner' → 'superadmin'.
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptViewMode, UserPreferences } from './user';
import {
  COMPACT_TRANSCRIPT_LAUNCH_AT,
  canAssignUserRole,
  compareRoleAuthority,
  extractAgenticToolsPublicValuesAsync,
  hasMinimumRole,
  hasRoleAuthorityOver,
  normalizeRole,
  ROLES,
  resolveTranscriptViewMode,
} from './user';

describe('normalizeRole', () => {
  it('converts owner to superadmin', () => {
    expect(normalizeRole('owner')).toBe('superadmin');
  });

  it('passes through superadmin unchanged', () => {
    expect(normalizeRole('superadmin')).toBe('superadmin');
  });

  it('passes through admin unchanged', () => {
    expect(normalizeRole('admin')).toBe('admin');
  });

  it('passes through member unchanged', () => {
    expect(normalizeRole('member')).toBe('member');
  });

  it('passes through viewer unchanged', () => {
    expect(normalizeRole('viewer')).toBe('viewer');
  });

  it('defaults undefined to member', () => {
    expect(normalizeRole(undefined)).toBe('member');
  });
});

describe('role authority ordering', () => {
  const ordered = [ROLES.VIEWER, ROLES.MEMBER, ROLES.ADMIN, ROLES.SUPERADMIN] as const;

  it('orders every role from viewer through superadmin', () => {
    for (const [actorIndex, actor] of ordered.entries()) {
      for (const [targetIndex, target] of ordered.entries()) {
        expect(hasRoleAuthorityOver(actor, target)).toBe(actorIndex >= targetIndex);
        expect(canAssignUserRole(actor, target)).toBe(actorIndex >= targetIndex);
        expect(Math.sign(compareRoleAuthority(actor, target))).toBe(
          Math.sign(actorIndex - targetIndex)
        );
      }
    }
  });

  it('keeps owner as a read-compatible superadmin alias', () => {
    expect(compareRoleAuthority('owner', ROLES.SUPERADMIN)).toBe(0);
    expect(hasRoleAuthorityOver('owner', ROLES.ADMIN)).toBe(true);
  });

  it('does not grant authority to a missing or unknown role', () => {
    expect(hasMinimumRole(undefined, ROLES.VIEWER)).toBe(false);
    expect(hasMinimumRole('not-a-role', ROLES.VIEWER)).toBe(false);
    expect(hasRoleAuthorityOver(undefined, ROLES.VIEWER)).toBe(false);
    expect(hasRoleAuthorityOver('not-a-role', ROLES.VIEWER)).toBe(false);
    expect(hasRoleAuthorityOver('not-a-role', 'not-a-role')).toBe(false);
    expect(canAssignUserRole('not-a-role', 'not-a-role')).toBe(false);
  });
});

describe('owner-authorized public credential values', () => {
  it('opens only whitelisted fields sequentially and omits async failures per field', async () => {
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const result = await extractAgenticToolsPublicValuesAsync(
      {
        codex: { OPENAI_API_KEY: 'secret', OPENAI_BASE_URL: 'bad-url' },
        'claude-code': { ANTHROPIC_API_KEY: 'other-secret', ANTHROPIC_BASE_URL: 'good-url' },
      },
      async (value) => {
        calls.push(value);
        peak = Math.max(peak, ++active);
        try {
          await Promise.resolve();
          if (value === 'bad-url') throw new Error('synthetic corrupt field');
          return 'https://example.invalid';
        } finally {
          active--;
        }
      }
    );
    expect(calls).toEqual(['bad-url', 'good-url']);
    expect(peak).toBe(1);
    expect(result).toEqual({ 'claude-code': { ANTHROPIC_BASE_URL: 'https://example.invalid' } });
  });
});

describe('resolveTranscriptViewMode', () => {
  const asUser = (created_at: Date, preferences?: UserPreferences) => ({
    created_at,
    preferences,
  });
  const before = new Date(COMPACT_TRANSCRIPT_LAUNCH_AT - 1);
  const after = new Date(COMPACT_TRANSCRIPT_LAUNCH_AT + 1);

  it('defaults accounts created before launch to detailed', () => {
    expect(resolveTranscriptViewMode(asUser(before))).toBe('detailed');
  });

  it('defaults accounts created at or after launch to compact', () => {
    expect(resolveTranscriptViewMode(asUser(new Date(COMPACT_TRANSCRIPT_LAUNCH_AT)))).toBe(
      'compact'
    );
    expect(resolveTranscriptViewMode(asUser(after))).toBe('compact');
  });

  it('lets an explicit choice override the account-age default', () => {
    expect(resolveTranscriptViewMode(asUser(before, { transcriptViewMode: 'compact' }))).toBe(
      'compact'
    );
    expect(resolveTranscriptViewMode(asUser(after, { transcriptViewMode: 'detailed' }))).toBe(
      'detailed'
    );
  });

  it('falls back to detailed for a missing user or unusable created_at', () => {
    expect(resolveTranscriptViewMode(null)).toBe('detailed');
    expect(resolveTranscriptViewMode(asUser(new Date('not-a-date')))).toBe('detailed');
  });

  it('ignores a stored value outside the known family', () => {
    expect(
      resolveTranscriptViewMode(asUser(after, { transcriptViewMode: 'cozy' as TranscriptViewMode }))
    ).toBe('compact');
  });
});
