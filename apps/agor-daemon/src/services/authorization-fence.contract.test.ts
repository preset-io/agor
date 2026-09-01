import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('tenant authorization fence coverage', () => {
  const groups = readFileSync(join(__dirname, 'groups.ts'), 'utf8');
  const policies = readFileSync(join(__dirname, 'capability-policies.ts'), 'utf8');
  const fence = readFileSync(join(__dirname, 'tenant-authorization-fence.ts'), 'utf8');

  it('fences group lifecycle and every membership mutation in their transactions', () => {
    const lifecycle = groups.slice(
      groups.indexOf('export function createGroupsService'),
      groups.indexOf('export function createGroupMembershipsService')
    );
    expect(lifecycle.match(/runWithTenantDatabaseTransaction\(/g)).toHaveLength(3);
    expect(lifecycle.match(/lockTenantAuthorizationFence\(operationDb, params\)/g)).toHaveLength(3);

    const memberships = groups.slice(
      groups.indexOf('export function createGroupMembershipsService'),
      groups.indexOf('export function setupBranchEffectiveAccessService')
    );
    const lock = memberships.indexOf('lockTenantAuthorizationFence(operationDb, params)');
    const actorlessBypass = memberships.indexOf('if (!params?.provider && !authenticated?.user)');
    const serviceBypass = memberships.indexOf('if (authenticated?.user?._isServiceAccount)');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(actorlessBypass);
    expect(lock).toBeLessThan(serviceBypass);
    expect(memberships.match(/runWithTenantDatabaseTransaction\(/g)).toHaveLength(2);
  });

  it('fences the workspace session-sharing gate with policy and prompt admission', () => {
    const workspace = policies.slice(policies.indexOf("'workspace-preferences'"));
    const transaction = workspace.indexOf('runWithTenantDatabaseTransaction(');
    const lock = workspace.indexOf('lockTenantAuthorizationFence(operationDb, params)');
    const write = workspace.indexOf('setWorkspacePreferences(');
    expect(transaction).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(transaction);
    expect(write).toBeGreaterThan(lock);
  });

  it('does not exempt actorless or service-account authority mutations', () => {
    const implementation = fence.slice(
      fence.indexOf('export async function lockTenantAuthorizationFence'),
      fence.indexOf('export type CurrentTenantAuthorityActor')
    );
    expect(implementation).not.toContain('_isServiceAccount');
    expect(implementation).not.toContain('!params');
    expect(implementation).toContain('pg_advisory_xact_lock');
  });
});
