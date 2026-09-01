/**
 * The `mcp_member_policy` setting: what non-admin members may do with MCP
 * server configuration.
 *
 * Stored as one row in `app_variables`, the tenant-scoped key/value store, so
 * there is no table and no migration behind it — and no backfill when it later
 * gains a per-user override, because absence already means "inherit".
 *
 * Every enforcement point reads it through {@link resolveMcpMemberPolicy}.
 * `userId` is accepted and ignored today: a per-user override would consult it
 * first and fall back to the tenant value, and giving it to callers now is what
 * keeps that change from being a signature change across several security
 * boundaries, where the one call site that got missed would still be reading
 * the tenant value.
 */

import { sql } from 'drizzle-orm';
import type { MCPMemberPolicy, TenantID, UserID } from '../../types';
import { DEFAULT_MCP_MEMBER_POLICY, MCP_MEMBER_POLICIES } from '../../types';
import type { Database, TenantScopeAwareDatabase } from '../client';
import { isPostgresDatabase } from '../database-wrapper';
import { runWithTenantDatabaseScope, runWithTenantDatabaseTransaction } from '../tenant-scope';
import { AppVariableRepository } from './app-variables';

export const MCP_MEMBER_POLICY_NAMESPACE = 'mcp';
export const MCP_MEMBER_POLICY_KEY = 'member_policy';

function parseStoredPolicy(raw: string | null): MCPMemberPolicy {
  if (raw === null) return DEFAULT_MCP_MEMBER_POLICY;
  const trimmed = raw.trim();
  if ((MCP_MEMBER_POLICIES as readonly string[]).includes(trimmed)) {
    return trimmed as MCPMemberPolicy;
  }
  // An unreadable setting must not widen what members can do.
  console.warn(
    `⚠️  Ignoring unrecognized mcp_member_policy "${trimmed}"; falling back to ${DEFAULT_MCP_MEMBER_POLICY}`
  );
  return DEFAULT_MCP_MEMBER_POLICY;
}

async function lockMcpMemberPolicyAuthority(
  db: Database,
  tenantId: TenantID | string | undefined
): Promise<void> {
  if (!isPostgresDatabase(db)) return;
  const lockName = `agor:mcp-member-policy:${tenantId ?? '<static>'}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`);
}

/**
 * The MCP member policy in force for a user. The user is unused while the
 * setting is tenant-wide; see the module comment for why it is a parameter.
 */
export async function resolveMcpMemberPolicy(
  db: TenantScopeAwareDatabase | Database,
  _userId: UserID | string | null | undefined,
  tenantId: TenantID | string | undefined
): Promise<MCPMemberPolicy> {
  return runWithTenantDatabaseScope(db, tenantId, async (scopedDb) => {
    const raw = await new AppVariableRepository(scopedDb).getPlain(
      MCP_MEMBER_POLICY_NAMESPACE,
      MCP_MEMBER_POLICY_KEY
    );
    return parseStoredPolicy(raw);
  });
}

/**
 * Reload the policy under the transaction-wide authority lock shared with its
 * writer. SQLite callers must already be in an IMMEDIATE transaction; the
 * Marketplace action service supplies that boundary.
 */
export async function resolveMcpMemberPolicyForUpdate(
  db: TenantScopeAwareDatabase | Database,
  _userId: UserID | string | null | undefined,
  tenantId: TenantID | string | undefined
): Promise<MCPMemberPolicy> {
  return runWithTenantDatabaseScope(db, tenantId, async (scopedDb) => {
    await lockMcpMemberPolicyAuthority(scopedDb, tenantId);
    const raw = await new AppVariableRepository(scopedDb).getPlain(
      MCP_MEMBER_POLICY_NAMESPACE,
      MCP_MEMBER_POLICY_KEY
    );
    return parseStoredPolicy(raw);
  });
}

/** Write the tenant-wide MCP member policy. */
export async function setMcpMemberPolicy(
  db: TenantScopeAwareDatabase | Database,
  policy: MCPMemberPolicy,
  tenantId: TenantID | string | undefined,
  updatedBy?: UserID | null
): Promise<void> {
  if (!(MCP_MEMBER_POLICIES as readonly string[]).includes(policy)) {
    throw new Error(`Unknown mcp_member_policy: ${policy}`);
  }
  // A single SQLite UPSERT is already serialized against the Marketplace
  // action's BEGIN IMMEDIATE transaction. Avoiding a needless nested client
  // transaction also preserves `:memory:` connection identity in lightweight
  // service harnesses.
  if (!isPostgresDatabase(db)) {
    await runWithTenantDatabaseScope(db, tenantId, (scopedDb) =>
      new AppVariableRepository(scopedDb).set({
        namespace: MCP_MEMBER_POLICY_NAMESPACE,
        key: MCP_MEMBER_POLICY_KEY,
        value: policy,
        updated_by: updatedBy ?? null,
      })
    );
    return;
  }
  await runWithTenantDatabaseTransaction(db, tenantId, async (scopedDb) => {
    await lockMcpMemberPolicyAuthority(scopedDb, tenantId);
    await new AppVariableRepository(scopedDb).set({
      namespace: MCP_MEMBER_POLICY_NAMESPACE,
      key: MCP_MEMBER_POLICY_KEY,
      value: policy,
      updated_by: updatedBy ?? null,
    });
  });
}
