/** Tenant projections of the cell journal. Every projection consumes every page independently. */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type {
  MCPManagedOAuthGrantMetadata,
  MCPManagedOAuthInvalidation,
  MCPManagedOAuthInvalidationPage,
  MCPManagedOAuthInvalidationRead,
  MCPManagedOAuthInvalidationScope,
} from '../../types/mcp-managed-oauth';
import {
  McpOAuthInvalidationResponseSchema,
  McpOAuthInvalidationSchema,
  McpOAuthOwnerSchema,
} from '../../types/mcp-managed-oauth-contract';
import type { Database } from '../client';
import { executeRaw, rawRows } from '../database-wrapper';
import { lockTenantAuthoritySubject } from './authority-primitives';
import { RepositoryError } from './base';

const MAX_TOMBSTONES = 10000;
function key(scope: MCPManagedOAuthInvalidationScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.tenant_id,
        scope.cell_id,
        scope.environment,
        scope.residency_region,
        scope.recovery_incarnation,
      ])
    )
    .digest('hex');
}
function items(value: unknown): MCPManagedOAuthInvalidation[] {
  if (!Array.isArray(value)) throw new RepositoryError('Invalid managed invalidation checkpoint');
  return value.map((item) => McpOAuthInvalidationSchema.parse(item));
}
function union(...sets: MCPManagedOAuthInvalidation[][]): MCPManagedOAuthInvalidation[] {
  const byKey = new Map<string, MCPManagedOAuthInvalidation>();
  for (const set of sets)
    for (const item of set) {
      const k = JSON.stringify([
        item.workspace_id,
        item.recovery_incarnation,
        item.subject,
        item.handle,
        item.reason,
      ]);
      const old = byKey.get(k);
      if (!old || BigInt(old.epoch) < BigInt(item.epoch)) byKey.set(k, item);
    }
  return [...byKey.values()];
}
export class MCPManagedOAuthInvalidationRepository {
  constructor(private readonly db: Database) {}
  private async lock(scope: MCPManagedOAuthInvalidationScope): Promise<string> {
    const k = key(scope);
    await lockTenantAuthoritySubject(this.db, scope.tenant_id, `mcp-managed-invalidation:${k}`);
    return k;
  }
  /**
   * One MVCC statement observes both sides of the atomic pending -> token transfer.
   * Never use a fresh clock to expire rows from an older repeatable-read snapshot:
   * even expired pending rows conservatively pin evidence until durably terminal.
   * New attempts cannot reuse a globally unique closed handle; deleted refresh
   * owners cannot insert a replacement token via their update-only completion CAS.
   */
  private async compact(
    scope: MCPManagedOAuthInvalidationScope,
    values: MCPManagedOAuthInvalidation[]
  ): Promise<MCPManagedOAuthInvalidation[]> {
    const ownerScope = JSON.stringify({
      workspace_id: scope.tenant_id,
      cell_id: scope.cell_id,
      environment: scope.environment,
      residency_region: scope.residency_region,
      recovery_incarnation: scope.recovery_incarnation,
    });
    const rows = rawRows(
      await executeRaw(
        this.db,
        sql`SELECT managed_metadata->>'handle' AS handle, false AS pending
          FROM public.user_mcp_oauth_tokens
          WHERE tenant_id=${scope.tenant_id} AND credential_origin='cloud_managed_v1'
            AND managed_metadata->'owner' @> ${ownerScope}::jsonb
          UNION ALL
          SELECT NULL AS handle, true AS pending WHERE EXISTS (
            SELECT 1 FROM public.mcp_oauth_pending_flows
            WHERE tenant_id=${scope.tenant_id} AND credential_origin='cloud_managed_v1'
              AND managed_metadata->'owner' @> ${ownerScope}::jsonb
              AND is_current AND status IN ('pending','exchanging'))`
      )
    );
    const pending = rows.some((row) => row.pending === true);
    const handles = new Set(rows.filter((row) => !row.pending).map((row) => row.handle));
    const retained = values.filter(
      (item) => pending || item.handle === null || handles.has(item.handle)
    );
    if (retained.length > MAX_TOMBSTONES)
      throw new RepositoryError(
        'Managed invalidation capacity exceeded; checkpoint cannot advance'
      );
    return retained;
  }
  /** Missing/restarted/partial state is denied by the consumer, never treated as an empty allow-list. */
  async readForGrant(
    scope: MCPManagedOAuthInvalidationScope,
    metadata: MCPManagedOAuthGrantMetadata
  ): Promise<MCPManagedOAuthInvalidationRead> {
    const owner = McpOAuthOwnerSchema.parse(metadata.owner);
    if (
      owner.workspace_id !== scope.tenant_id ||
      owner.cell_id !== scope.cell_id ||
      owner.environment !== scope.environment ||
      owner.residency_region !== scope.residency_region ||
      owner.recovery_incarnation !== scope.recovery_incarnation
    )
      throw new RepositoryError('Managed invalidation scope mismatch');
    const read = await this.read(scope);
    return {
      ...read,
      items: read.items.filter(
        (item) =>
          (item.subject === null || item.subject === owner.cloud_user_subject) &&
          (item.handle === null || item.handle === metadata.handle)
      ),
    };
  }
  async read(scope: MCPManagedOAuthInvalidationScope): Promise<MCPManagedOAuthInvalidationRead> {
    const k = await this.lock(scope);
    const row = rawRows(
      await executeRaw(
        this.db,
        sql`SELECT status,cursor,items,staged_items FROM public.mcp_managed_oauth_invalidations WHERE tenant_id=${scope.tenant_id} AND scope_key=${k}`
      )
    )[0];
    if (!row) return { status: 'snapshot_required', cursor: null, items: [] };
    if (!['ready', 'snapshot_required', 'snapshot_staging'].includes(String(row.status)))
      throw new RepositoryError('Invalid managed checkpoint state');
    return {
      status: row.status as MCPManagedOAuthInvalidationRead['status'],
      cursor: row.cursor as string | null,
      items: await this.compact(scope, union(items(row.items), items(row.staged_items))),
    };
  }
  async requireSnapshot(scope: MCPManagedOAuthInvalidationScope): Promise<void> {
    const k = await this.lock(scope);
    await executeRaw(
      this.db,
      sql`INSERT INTO public.mcp_managed_oauth_invalidations
      (tenant_id,scope_key,cell_id,environment,residency_region,recovery_incarnation,status,cursor,items,staged_items,updated_at)
      VALUES (${scope.tenant_id},${k},${scope.cell_id},${scope.environment},${scope.residency_region},${scope.recovery_incarnation},'snapshot_required',NULL,'[]'::jsonb,'[]'::jsonb,clock_timestamp())
      ON CONFLICT (scope_key) DO UPDATE SET status='snapshot_required',cursor=NULL,updated_at=clock_timestamp()`
    );
  }
  /** Only a validated whole page can move the cursor, in the same transaction as its evidence/tombstones. */
  async applyPage(
    scope: MCPManagedOAuthInvalidationScope,
    expectedCursor: string | null,
    input: MCPManagedOAuthInvalidationPage,
    options: { snapshot?: boolean } = {}
  ): Promise<boolean> {
    const page = McpOAuthInvalidationResponseSchema.parse(input);
    if (page.recovery_incarnation !== scope.recovery_incarnation)
      throw new RepositoryError('Managed invalidation incarnation changed');
    const k = await this.lock(scope);
    const old = await this.read(scope);
    if (old.cursor !== expectedCursor) return false;
    if (page.snapshot_required) {
      await this.requireSnapshot(scope);
      return true;
    }
    if (old.status !== 'ready' && !options.snapshot)
      throw new RepositoryError('Managed invalidation snapshot required');
    if (expectedCursor !== null && BigInt(page.next_cursor) < BigInt(expectedCursor))
      throw new RepositoryError('Managed invalidation cursor regressed');
    if (
      page.items.some(
        (item) =>
          BigInt(item.cursor) > BigInt(page.next_cursor) ||
          item.recovery_incarnation !== scope.recovery_incarnation
      )
    )
      throw new RepositoryError('Managed invalidation page fence mismatch');
    const selected = page.items.filter((item) => item.workspace_id === scope.tenant_id);
    // Snapshot staging retains every invalidation which can still affect local authority.
    const merged = await this.compact(scope, union(old.items, selected));
    const status = options.snapshot && !page.snapshot_complete ? 'snapshot_staging' : 'ready';
    const digest = createHash('sha256').update(JSON.stringify(page)).digest('hex');
    await executeRaw(
      this.db,
      sql`INSERT INTO public.mcp_managed_oauth_invalidations
      (tenant_id,scope_key,cell_id,environment,residency_region,recovery_incarnation,status,cursor,page_digest,items,staged_items,updated_at)
      VALUES (${scope.tenant_id},${k},${scope.cell_id},${scope.environment},${scope.residency_region},${scope.recovery_incarnation},${status},${page.next_cursor},${digest},${JSON.stringify(merged)}::jsonb,'[]'::jsonb,clock_timestamp())
      ON CONFLICT (scope_key) DO UPDATE SET status=EXCLUDED.status,cursor=EXCLUDED.cursor,page_digest=EXCLUDED.page_digest,
        items=EXCLUDED.items,staged_items=EXCLUDED.staged_items,updated_at=clock_timestamp()`
    );
    return true;
  }
}
