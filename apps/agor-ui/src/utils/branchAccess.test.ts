import type { EffectiveBranchAccess } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  type BranchAccessLookup,
  canManageBranch,
  canStartSessions,
  provisioningAccess,
} from './branchAccess';

const access = (fields: Partial<EffectiveBranchAccess>): EffectiveBranchAccess => ({
  can: 'none',
  is_owner: false,
  source: 'group',
  ...fields,
});

describe('canStartSessions', () => {
  it('starts at the session level', () => {
    expect(
      ['none', 'view', 'session', 'prompt', 'all'].map((can) => canStartSessions({ can } as never))
    ).toEqual([false, false, true, true, true]);
  });
});

describe('provisioningAccess', () => {
  it.each<[string, BranchAccessLookup, string | undefined, string]>([
    ['owner', access({ is_owner: true }), 'member', 'allowed'],
    ['all with write', access({ can: 'all', fs_access: 'write' }), 'member', 'allowed'],
    ['all with read', access({ can: 'all', fs_access: 'read' }), 'member', 'denied'],
    ['all without filesystem access', access({ can: 'all' }), 'member', 'denied'],
    ['prompt with write', access({ can: 'prompt', fs_access: 'write' }), 'member', 'denied'],
    ['administrator without all', access({ can: 'prompt' }), 'admin', 'denied'],
    ['superadmin the lookup refuses', access({ can: 'view' }), 'superadmin', 'unknown'],
    ['viewer who owns the branch', access({ is_owner: true }), 'viewer', 'denied'],
    ['lookup failed', 'failed', 'member', 'unknown'],
    ['lookup loading', 'loading', 'member', 'loading'],
    ['no signed-in user', 'failed', undefined, 'unknown'],
  ])('%s', (_name, lookup, role, expected) => {
    expect(provisioningAccess(lookup, role)).toBe(expected);
  });
});

describe('canManageBranch', () => {
  it.each<[string, BranchAccessLookup, boolean]>([
    ['owner', access({ is_owner: true }), true],
    ['all', access({ can: 'all' }), true],
    ['prompt', access({ can: 'prompt' }), false],
    ['lookup failed', 'failed', false],
    ['lookup loading', 'loading', false],
  ])('%s', (_name, lookup, expected) => {
    expect(canManageBranch(lookup)).toBe(expected);
  });
});
