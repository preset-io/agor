/**
 * The entitlement an MCP OAuth grant must satisfy to become durable.
 *
 * This is enforced at the *writes* rather than at the endpoints, and that is
 * the whole point of the module.
 *
 * The first attempt at #2301 floored the caller on each endpoint that mints a
 * credential, and a test scanned `register-services.ts` to prove no endpoint
 * had been forgotten. A scan over call sites cannot establish that property: it
 * enumerates callers, and callers are exactly what is easy to add, alias
 * (`const mint = refreshAndPersistToken`), or wrap. Every such bypass reaches
 * the same two writes, so the check belongs there — at the choke point, where
 * being reached is a fact about the code rather than a claim about a survey.
 *
 * A caller may not pre-satisfy this by having checked earlier. The functions
 * that persist a grant call it themselves, immediately before the write and
 * inside the same tenant unit of work, so a new endpoint, an aliased import or
 * a helper defined elsewhere all arrive here regardless.
 *
 * ## Residual race — read before assuming this is airtight
 *
 * The check reads the subject's role and the write then lands. On PostgreSQL
 * both happen inside one `runWithTenantDatabaseScope` transaction, which is why
 * the assertion is invoked inside that callback rather than before it. Even so,
 * the users row is not locked: a demotion committing between this read and the
 * grant write can still be ordered such that the write lands. The window is a
 * few statements rather than the provider round-trip it replaced, but it is not
 * zero.
 *
 * Closing it entirely needs the users row locked for the duration
 * (`SELECT ... FOR UPDATE`) or the grant write made conditional on the role in
 * a single statement. Both are worth doing and neither is done here; see the
 * PR discussion on #2301. Do not describe this as a closed race.
 */

import { runWithTenantDatabaseScope } from '../../db';
import type { Database, TenantScopeAwareDatabase } from '../../db/client';
import { UsersRepository } from '../../db/repositories';
import { isMcpGrantSubjectEntitled } from '../../mcp/member-policy';

/** Refusal to persist a grant for a subject who no longer stands where they did. */
export class MCPGrantSubjectNotEntitledError extends Error {
  constructor(
    public readonly subjectUserId: string,
    public readonly oauthMode: 'per_user' | 'shared'
  ) {
    super(
      oauthMode === 'shared'
        ? 'Shared MCP OAuth grant requires current admin access'
        : 'MCP OAuth grant requires current member access'
    );
    this.name = 'MCPGrantSubjectNotEntitledError';
  }
}

export interface McpGrantSubjectCheck {
  db: TenantScopeAwareDatabase | Database;
  tenantId?: string;
  /**
   * The user the grant is keyed on, or `null` for a tenant-owned `shared`
   * grant. `null` passes: a shared grant belongs to the workspace rather than
   * to a person, is admin-only to establish, and has no individual standing to
   * re-check. Where a shared flow's *initiator* is known — the callback path —
   * callers pass that id instead, and the admin floor applies.
   */
  subjectUserId: string | null | undefined;
  oauthMode: 'per_user' | 'shared';
}

/**
 * Refuse the write unless the grant's subject is still entitled to hold it.
 *
 * Fails closed on an unknown subject: a grant that cannot be attributed to a
 * current user is not one to keep minting. An absent `subjectUserId` is the
 * tenant-owned case and passes — see {@link McpGrantSubjectCheck}.
 */
export async function assertMcpGrantSubjectEntitled(check: McpGrantSubjectCheck): Promise<void> {
  const { subjectUserId, oauthMode } = check;
  if (subjectUserId === null || subjectUserId === undefined) return;

  const subject = await runWithTenantDatabaseScope(check.db, check.tenantId, (scoped) =>
    new UsersRepository(scoped as Database).findById(subjectUserId)
  );
  if (!subject || !isMcpGrantSubjectEntitled(subject.role, oauthMode)) {
    throw new MCPGrantSubjectNotEntitledError(subjectUserId, oauthMode);
  }
}
