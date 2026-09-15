import {
  executeRaw,
  isPostgresDatabaseHandle,
  rawRows,
  runWithTenantDatabaseScope,
  sql,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import {
  hasMinimumRole,
  McpOAuthIdSchema,
  type McpOAuthOwner,
  ROLES,
  type UserID,
} from '@agor/core/types';

/** Nonsecret deployment identity provider, never a request-selected issuer. */
export interface ManagedOAuthLocalIdentityPolicy {
  provider: string;
  issuer: string;
}

/**
 * The normalized external-identity relation is authority, not users.data,
 * email, an executor claim or a browser-supplied Cloud subject. Locks retain
 * exact role/identity through the enclosing local write transaction.
 */
export async function resolveManagedOAuthLocalSubject(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  userId: UserID,
  policy: ManagedOAuthLocalIdentityPolicy
): Promise<string> {
  if (!isPostgresDatabaseHandle(db) || !tenantId || !userId || !policy.provider || !policy.issuer) {
    throw new Error('Managed MCP OAuth requires trusted cell identity');
  }
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const rows = rawRows(
      await executeRaw(
        scoped,
        sql`
      SELECT i.subject, u.role
      FROM user_external_identities i
      JOIN users u ON u.tenant_id = i.tenant_id AND u.user_id = i.user_id
      WHERE i.tenant_id = ${tenantId} AND i.user_id = ${userId}
        AND i.provider = ${policy.provider} AND i.issuer = ${policy.issuer}
      FOR SHARE OF u, i
    `
      )
    );
    if (rows.length !== 1 || !hasMinimumRole(String(rows[0].role), ROLES.MEMBER)) {
      throw new Error('Managed MCP OAuth subject is unavailable');
    }
    const subject = McpOAuthIdSchema.safeParse(rows[0].subject);
    if (!subject.success) throw new Error('Managed MCP OAuth subject is unavailable');
    return subject.data;
  });
}

export async function assertManagedOAuthLocalOwner(
  db: TenantScopeAwareDatabase,
  tenantId: string,
  userId: UserID,
  policy: ManagedOAuthLocalIdentityPolicy,
  owner: McpOAuthOwner
): Promise<void> {
  if (owner.workspace_id !== tenantId || owner.cell_local_user_id !== userId) {
    throw new Error('Managed MCP OAuth local owner changed');
  }
  const subject = await resolveManagedOAuthLocalSubject(db, tenantId, userId, policy);
  if (subject !== owner.cloud_user_subject)
    throw new Error('Managed MCP OAuth local owner changed');
}
