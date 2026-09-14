/**
 * Permanent, audited, idempotent deletion of all data belonging to a single
 * tenant.
 *
 * Operators of a standalone multi-tenant PostgreSQL runtime need a verifiable
 * way to remove a tenant entirely (offboarding, data-removal requests,
 * regulatory erasure). This module performs that removal against a deletion
 * plan assembled from the runtime-derived
 * {@link buildTenantDeletionManifest tenant manifest} and the registry of
 * tenant tables created imperatively at runtime:
 *
 *   1. Validate the tenant id (refuse empty / whitespace / wildcard values).
 *   2. Reconcile the plan against the live PostgreSQL catalog and fail closed if
 *      any tenant-contract table is missing or malformed.
 *   3. Delete every tenant-scoped row inside a single tenant-scoped transaction,
 *      following the compiled schema's defensive child-before-parent order.
 *   4. Reconcile the live catalog again, independently rebuild the verification
 *      plan, and re-scan committed state in a fresh transaction. Fail unless the
 *      catalog contract is unchanged and zero tenant rows remain.
 *
 * Running it twice on the same tenant is safe: the second run deletes zero rows
 * and still reports success. Multi-tenancy is PostgreSQL-only, so the command
 * refuses to run against a SQLite database.
 *
 * Preconditions:
 *
 * - Quiesce tenant writes and relevant schema changes for the entire operation.
 *   The table locks and second catalog scan narrow races but do not fence a
 *   writer or DDL that commits after final verification.
 * - Maintain a tenant-consistent foreign-key graph: every foreign-key reference
 *   from a tenant-scoped row to another tenant-scoped row must connect rows with
 *   the same tenant id. PostgreSQL row-level security does not enforce that
 *   equality when a foreign key is created and does not constrain referential
 *   actions such as cascades. This routine validates the supported RLS policy
 *   contract, but it does not prove row-level foreign-key consistency.
 *
 * The result object is a frozen machine-readable contract (see
 * {@link TenantDeletionResult}) intended to be parsed by external automation. It
 * contains only booleans, numbers, and identifier strings — never row content,
 * connection strings, or other secrets.
 */

import { sql } from 'drizzle-orm';
import type { Database } from './client';
import { executeRaw, isPostgresDatabase } from './database-wrapper';
import { checkMigrationStatus } from './migrate';
import {
  buildTenantDeletionManifest,
  GLOBAL_TABLES,
  type TenantDeletionTable,
} from './tenant-deletion-manifest';
import { IMPERATIVE_TENANT_TABLES, type ImperativeTenantTable } from './tenant-imperative-tables';
import { getCurrentTenantDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';
import { assertTenantWriteGateGeneration } from './tenant-write-gate';

/** Thrown when the supplied tenant id is empty, blank, or wildcard-like. */
export class InvalidTenantIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTenantIdError';
  }
}

/** Thrown when tenant deletion is attempted against a non-multi-tenant database. */
export class TenantDeletionUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantDeletionUnsupportedError';
  }
}

/** Thrown when the live catalog cannot prove that the deletion plan is exhaustive. */
export class TenantDeletionCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantDeletionCatalogError';
  }
}

/** Thrown when post-deletion verification still finds tenant rows. */
export class TenantDeletionVerificationError extends Error {
  /** Names of tables that still contain rows for the tenant. */
  readonly tables: string[];
  constructor(tables: string[]) {
    super(
      `Tenant deletion verification failed: ${tables.length} table(s) still contain tenant rows`
    );
    this.name = 'TenantDeletionVerificationError';
    this.tables = tables;
  }
}

/**
 * Stable machine-readable success contract. Key names are frozen — external
 * automation parses them exactly. Only booleans, numbers, and identifier
 * strings are ever emitted.
 */
export interface TenantDeletionResult {
  tenantDataDeleted: true;
  /** Current applied schema/migration version (last applied migration tag). */
  schemaVersion: string;
  /** Rows deleted per table. Every plan table is present, even at zero. */
  rowCounts: Record<string, number>;
}

/** Result of a `--dry-run`: reports would-be deletions without mutating data. */
export interface TenantDeletionDryRunResult {
  tenantDataDeleted: false;
  dryRun: true;
  schemaVersion: string;
  /** Rows that WOULD be deleted per table. */
  rowCounts: Record<string, number>;
}

export interface TenantDeletionOptions {
  /** Report counts without deleting anything. */
  dryRun?: boolean;
  /** Human-readable audit sink (secret-safe). Defaults to a no-op. */
  log?: (message: string) => void;
  /**
   * When set, the deletion transaction asserts — inside the same transaction,
   * before any rows are removed — that the tenant write gate is held at exactly
   * this generation. If the gate was lost or replaced (writes may have resumed),
   * the transaction aborts and nothing is deleted. Bind this to a gate the caller
   * acquired and confirmed still held. See {@link assertTenantWriteGateGeneration}.
   */
  assertGateGeneration?: string;
}

/** Wildcard-like characters that must never be accepted as a concrete tenant id. */
const WILDCARD_CHARACTERS = /[%*]/;
/** Unicode control and formatting characters can forge terminal or audit output. */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

/**
 * Validate a tenant id, refusing empty, whitespace-only, whitespace-padded, and
 * wildcard-like or non-printable values. A concrete id such as `default` or a
 * UUID is accepted.
 */
export function assertValidTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string') {
    throw new InvalidTenantIdError('A tenant id is required');
  }
  if (tenantId.length === 0) {
    throw new InvalidTenantIdError('Tenant id must not be empty');
  }
  if (tenantId.trim().length === 0) {
    throw new InvalidTenantIdError('Tenant id must not be blank');
  }
  if (tenantId.trim() !== tenantId) {
    throw new InvalidTenantIdError('Tenant id must not have leading or trailing whitespace');
  }
  if (WILDCARD_CHARACTERS.test(tenantId)) {
    throw new InvalidTenantIdError('Tenant id must not contain wildcard characters ("%" or "*")');
  }
  if (CONTROL_CHARACTERS.test(tenantId)) {
    throw new InvalidTenantIdError('Tenant id must not contain control or formatting characters');
  }
}

/**
 * Convert the set of tables that still hold tenant rows after deletion into a
 * thrown {@link TenantDeletionVerificationError}. Extracted so the failure path
 * is unit-testable without a live database.
 */
export function assertNoRemainingTenantRows(remaining: string[]): void {
  if (remaining.length > 0) {
    throw new TenantDeletionVerificationError(remaining);
  }
}

async function resolveSchemaVersion(db: Database): Promise<string> {
  const status = await checkMigrationStatus(db);
  // This migration-watermark check is a conservative compatibility guard, not a
  // proof that the compiled schema equals the live catalog. Exhaustiveness is
  // established separately by the catalog reconciliation before any deletion.
  //
  // DB ahead of binary: the database was migrated by a newer release, so this
  // binary's schema omits tables the database now has. Deleting + verifying
  // against that incomplete manifest would falsely certify success while tenant
  // data survives in tables this binary cannot see.
  if (status.dbAheadOfBinary) {
    throw new Error(
      'Database schema is newer than this binary: the database has migrations this release does not know about. ' +
        'Refusing to run tenant deletion because the deletion manifest may be incomplete and could falsely certify success. ' +
        'Upgrade this binary to match the database, then retry.'
    );
  }
  // Binary ahead of DB (pending migrations): this binary has migrations the DB
  // has not applied. If a pending migration DROPS or RENAMES a tenant-scoped
  // table, the live database still holds that table with tenant data, but this
  // binary's compiled schema no longer lists it under that name — so the manifest
  // omits it, deletion skips it, and verification (scanning the same manifest)
  // reports false success while tenant data survives. (The ADD-a-table case does
  // fail loudly with 'relation does not exist', but the DROP/RENAME case does
  // not — hence this guard.)
  if (status.hasPending) {
    throw new Error(
      `Refusing to delete tenant data: the database has ${status.pending.length} pending migration(s); ` +
        "the running binary's migration watermark is not compatible with the database. " +
        'Apply the pending migrations before deleting a tenant ' +
        '(a pending migration may drop or rename a tenant-scoped table, which would make deletion silently incomplete).'
    );
  }
  const applied = status.applied;
  if (applied.length === 0) {
    throw new Error(
      'Database has no applied migrations; refusing to run tenant deletion against an uninitialized schema'
    );
  }
  return applied[applied.length - 1];
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function boolValue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1 || value === '1';
}

interface CatalogPolicy {
  name: string;
  command: string;
  permissive: boolean;
  publicOnly: boolean;
  roles: string;
  usingExpression: string | null;
  checkExpression: string | null;
  usingTree: string | null;
  checkTree: string | null;
}

interface CatalogRelation {
  relationId: string;
  schemaName: string;
  tableName: string;
  relkind: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  hasTenantColumn: boolean;
  tenantColumnTextNotNull: boolean;
  participatesInInheritance: boolean;
  foreignKeyContract: string;
  policies: CatalogPolicy[];
}

/**
 * Read every non-system ordinary or partitioned relation that claims some part
 * of the tenant contract. Every system-catalog reference is explicitly
 * pg_catalog-qualified so a hostile search_path or temporary relation cannot
 * redirect the audit.
 */
async function readTenantCatalog(db: Database): Promise<CatalogRelation[]> {
  const result = await executeRaw(
    db,
    sql`
      SELECT
        c.oid::pg_catalog.text AS relation_id,
        n.nspname AS schema_name,
        c.relname AS table_name,
        c.relkind::pg_catalog.text AS relkind,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'tenant_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
        ) AS has_tenant_column,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'tenant_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
            AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype
            AND a.attnotnull
        ) AS tenant_column_text_not_null,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_inherits i
          WHERE i.inhrelid = c.oid OR i.inhparent = c.oid
        ) AS participates_in_inheritance,
        COALESCE(
          (
            SELECT pg_catalog.string_agg(
              pg_catalog.concat_ws(
                ':',
                fk.oid::pg_catalog.text,
                fk.conrelid::pg_catalog.text,
                fk.confrelid::pg_catalog.text,
                pg_catalog.pg_get_constraintdef(fk.oid, false)
              ),
              E'\n'
              ORDER BY fk.oid
            )
            FROM pg_catalog.pg_constraint fk
            WHERE fk.contype = 'f'
              AND (fk.conrelid = c.oid OR fk.confrelid = c.oid)
          ),
          ''
        ) AS foreign_key_contract,
        p.polname AS policy_name,
        p.polcmd::pg_catalog.text AS policy_command,
        p.polpermissive AS policy_permissive,
        p.polroles::pg_catalog.text AS policy_roles,
        p.polroles = ARRAY[0::pg_catalog.oid] AS policy_public_only,
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS policy_using_expression,
        pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS policy_check_expression,
        p.polqual::pg_catalog.text AS policy_using_tree,
        p.polwithcheck::pg_catalog.text AS policy_check_tree
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_policy p ON p.polrelid = c.oid
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg_%'
        AND (
          c.relforcerowsecurity
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = c.oid
              AND a.attname = 'tenant_id'
              AND a.attnum > 0
              AND NOT a.attisdropped
          )
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_policy marker_policy
            WHERE marker_policy.polrelid = c.oid
              AND (
                marker_policy.polname LIKE 'tenant_isolation_%'
                OR COALESCE(
                    pg_catalog.pg_get_expr(
                      marker_policy.polqual,
                      marker_policy.polrelid
                    ),
                    ''
                  ) LIKE '%agor.tenant_id%'
                OR COALESCE(
                    pg_catalog.pg_get_expr(
                      marker_policy.polwithcheck,
                      marker_policy.polrelid
                    ),
                    ''
                  ) LIKE '%agor.tenant_id%'
              )
          )
        )
      ORDER BY n.nspname, c.relname, p.polname
    `
  );

  const relations = new Map<string, CatalogRelation>();
  for (const row of rowsOf(result)) {
    const relationId = String(row.relation_id);
    let relation = relations.get(relationId);
    if (!relation) {
      relation = {
        relationId,
        schemaName: String(row.schema_name),
        tableName: String(row.table_name),
        relkind: String(row.relkind),
        rlsEnabled: boolValue(row.rls_enabled),
        rlsForced: boolValue(row.rls_forced),
        hasTenantColumn: boolValue(row.has_tenant_column),
        tenantColumnTextNotNull: boolValue(row.tenant_column_text_not_null),
        participatesInInheritance: boolValue(row.participates_in_inheritance),
        foreignKeyContract: String(row.foreign_key_contract),
        policies: [],
      };
      relations.set(relationId, relation);
    }
    if (row.policy_name !== null && row.policy_name !== undefined) {
      relation.policies.push({
        name: String(row.policy_name),
        command: String(row.policy_command),
        permissive: boolValue(row.policy_permissive),
        publicOnly: boolValue(row.policy_public_only),
        roles: String(row.policy_roles),
        usingExpression:
          row.policy_using_expression === null || row.policy_using_expression === undefined
            ? null
            : String(row.policy_using_expression),
        checkExpression:
          row.policy_check_expression === null || row.policy_check_expression === undefined
            ? null
            : String(row.policy_check_expression),
        usingTree:
          row.policy_using_tree === null || row.policy_using_tree === undefined
            ? null
            : String(row.policy_using_tree),
        checkTree:
          row.policy_check_tree === null || row.policy_check_tree === undefined
            ? null
            : String(row.policy_check_tree),
      });
    }
  }
  return [...relations.values()];
}

const CANONICAL_TENANT_POLICY_EXPRESSION =
  "tenant_id=coalesce(nullif(current_setting('agor.tenant_id',true),''),'default')";
const STRICT_TENANT_POLICY_EXPRESSION =
  "tenant_id=nullif(current_setting('agor.tenant_id',true),'')";
// The pending OAuth table also exposes two narrow transaction-local system
// capabilities for an unauthenticated provider callback and bounded cleanup.
// Its ordinary tenant policy must be disabled while either capability is
// active; otherwise permissive RLS policies would OR the default-tenant arm
// with the state-hash capability and broaden callback visibility. Keep this as
// an exact table-specific contract rather than accepting arbitrary predicates.
//
const MCP_OAUTH_PENDING_TENANT_POLICY_EXPRESSION =
  "(coalesce(current_setting('agor.system_scope',true),'')='')and(tenant_id=coalesce(nullif(current_setting('agor.tenant_id',true),''),'default'))";
// Claude has no unauthenticated callback. Its ordinary tenant arm additionally
// requires an explicit tenant GUC, including for `default`; the system-scope
// guard prevents the permissive maintenance policy from being ORed with it.
const CLAUDE_OAUTH_ATTEMPT_TENANT_POLICY_EXPRESSION =
  "(coalesce(current_setting('agor.system_scope',true),'')='')and(tenant_id=nullif(current_setting('agor.tenant_id',true),''))";

function stripOuterParentheses(expression: string): string {
  let current = expression;
  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0;
    let closesAtEnd = true;
    for (let index = 0; index < current.length; index += 1) {
      const character = current[index];
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (depth === 0 && index < current.length - 1) {
        closesAtEnd = false;
        break;
      }
    }
    if (!closesAtEnd) break;
    current = current.slice(1, -1);
  }
  return current;
}

/**
 * pg_get_expr is the server's structural deparser. Normalize only formatting,
 * identifier quoting, built-in qualification, and text casts that vary between
 * supported PostgreSQL releases; do not reorder or simplify operators.
 */
function normalizePolicyExpression(expression: string | null): string | null {
  if (expression === null) return null;
  const normalized = expression
    .replaceAll('"', '')
    .replace(/::(?:pg_catalog\.)?text\b/gi, '')
    .replace(/\bpg_catalog\.current_setting\b/gi, 'current_setting')
    .replace(/\s+/g, '')
    .toLowerCase();
  return stripOuterParentheses(normalized);
}

function assertSupportedPolicies(relation: CatalogRelation): void {
  const qualifiedName = `${relation.schemaName}.${relation.tableName}`;
  const expectedTenantPolicyExpression =
    relation.tableName === 'mcp_oauth_pending_flows' ||
    relation.tableName === 'mcp_oauth_client_registrations' ||
    relation.tableName === 'codex_device_auth_attempts'
      ? MCP_OAUTH_PENDING_TENANT_POLICY_EXPRESSION
      : relation.tableName === 'claude_oauth_attempts'
        ? CLAUDE_OAUTH_ATTEMPT_TENANT_POLICY_EXPRESSION
        : relation.tableName === 'github_install_states'
          ? STRICT_TENANT_POLICY_EXPRESSION
          : CANONICAL_TENANT_POLICY_EXPRESSION;

  const restrictive = relation.policies.filter((policy) => !policy.permissive);
  if (restrictive.length > 0) {
    throw new TenantDeletionCatalogError(
      `Refusing tenant deletion: ${qualifiedName} has unsupported restrictive row-security policy/policies: ${restrictive
        .map((policy) => policy.name)
        .sort()
        .join(', ')}`
    );
  }

  const expectedName = `tenant_isolation_${relation.tableName}`;
  const isolationPolicies = relation.policies.filter((policy) => policy.name === expectedName);
  if (isolationPolicies.length !== 1) {
    throw new TenantDeletionCatalogError(
      `Refusing tenant deletion: ${qualifiedName} must have exactly one ${expectedName} policy`
    );
  }

  const isolation = isolationPolicies[0];
  if (isolation.command !== '*') {
    throw new TenantDeletionCatalogError(
      `Refusing tenant deletion: ${qualifiedName}.${expectedName} must apply to ALL commands`
    );
  }
  if (!isolation.permissive) {
    throw new TenantDeletionCatalogError(
      `Refusing tenant deletion: ${qualifiedName}.${expectedName} must be permissive`
    );
  }
  if (!isolation.publicOnly) {
    throw new TenantDeletionCatalogError(
      `Refusing tenant deletion: ${qualifiedName}.${expectedName} must apply only to PUBLIC`
    );
  }
  const usingExpression = normalizePolicyExpression(isolation.usingExpression);
  const checkExpression = normalizePolicyExpression(isolation.checkExpression);
  if (
    usingExpression !== expectedTenantPolicyExpression ||
    checkExpression !== expectedTenantPolicyExpression
  ) {
    throw new TenantDeletionCatalogError(
      `Refusing tenant deletion: ${qualifiedName}.${expectedName} must use the canonical tenant_id equality and approved table-specific capability guard for both USING and WITH CHECK`
    );
  }
}

/**
 * Assert that a relation declared global really is.
 *
 * Live-catalog discovery selects on forced row security, which a global table
 * enables for its own capability policy rather than for tenant isolation. The
 * declaration in {@link GLOBAL_TABLES} is what tells the two apart, so it has to
 * be checked rather than trusted: a table that carries tenant data and is then
 * named here would otherwise skip the entire tenant contract and be silently
 * left behind by every deletion.
 *
 * Exported for its tests. {@link GLOBAL_TABLES} is empty, so nothing in the
 * live catalogue can reach this through `deleteTenantData` — and a guard for a
 * decision made this rarely is one that has to be exercised deliberately or it
 * will have quietly stopped working by the time it matters.
 */
export function assertDeclaredGlobalRelation(
  relation: CatalogRelation,
  qualifiedName: string
): void {
  if (relation.hasTenantColumn) {
    throw new TenantDeletionCatalogError(
      `Refusing tenant deletion: ${qualifiedName} is declared global but has a tenant_id column`
    );
  }
  for (const policy of relation.policies) {
    const referencesTenant =
      policy.name.startsWith('tenant_isolation_') ||
      (policy.usingExpression ?? '').includes('agor.tenant_id') ||
      (policy.checkExpression ?? '').includes('agor.tenant_id');
    if (referencesTenant) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: ${qualifiedName} is declared global but policy ${policy.name} scopes rows by tenant`
      );
    }
  }
}

/**
 * Reject a declared-global table that points a foreign key at tenant space.
 *
 * The declaration exempts a table from the whole tenant contract, which is only
 * defensible while it holds no reference to a tenant-scoped row. A constraint
 * into one leaves deletion blocking on it or cascading rows out of a table
 * nothing is allowed to touch, and every other guard here would still pass.
 *
 * Only outgoing references count. The contract also carries constraints that
 * point *at* this table, and those name the global itself rather than a tenant
 * table, so they cannot be confused for one.
 */
export function assertGlobalReferencesNoTenantTable(
  relation: CatalogRelation,
  tenantRelationsByOid: ReadonlyMap<string, CatalogRelation>
): void {
  const qualifiedName = `${relation.schemaName}.${relation.tableName}`;
  // Resolved by oid rather than by reading the constraint definition. A
  // rendered `REFERENCES` clause is schema-qualified whenever the target is not
  // on the search_path, so matching its text against bare table names both
  // misses `other.sessions` and cannot tell it apart from `public.sessions`.
  // The oid is unambiguous and already in the contract.
  for (const constraint of relation.foreignKeyContract.split('\n')) {
    if (!constraint) continue;
    const [, conrelid, confrelid] = constraint.split(':');
    // The contract carries constraints pointing at this table as well as from
    // it; only an outgoing reference puts tenant rows behind this one.
    if (conrelid !== relation.relationId) continue;
    if (confrelid === relation.relationId) continue;
    const parent = tenantRelationsByOid.get(confrelid);
    if (parent) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: ${qualifiedName} is declared global but references tenant-scoped ${parent.schemaName}.${parent.tableName}`
      );
    }
  }
}

interface CatalogAudit {
  liveTenantTables: ReadonlySet<string>;
  fingerprint: string;
}

/**
 * Assert the full contract for every catalog relation and reconcile the live set
 * against the typed manifest plus the constant imperative-table registry.
 */
async function auditLiveTenantCatalog(
  db: Database,
  planNames: ReadonlySet<string>
): Promise<CatalogAudit> {
  const relations = await readTenantCatalog(db);
  const liveTenantTables = new Set<string>();
  const declaredGlobals: CatalogRelation[] = [];

  for (const relation of relations) {
    const qualifiedName = `${relation.schemaName}.${relation.tableName}`;
    if (relation.schemaName !== 'public') {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: tenant-contract relation ${qualifiedName} is outside the public schema`
      );
    }
    if (relation.relkind === 'p') {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: tenant-contract relation ${qualifiedName} is partitioned`
      );
    }
    if (relation.participatesInInheritance) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: tenant-contract relation ${qualifiedName} participates in table inheritance`
      );
    }
    if (GLOBAL_TABLES.has(relation.tableName)) {
      assertDeclaredGlobalRelation(relation, qualifiedName);
      declaredGlobals.push(relation);
      continue;
    }
    if (!relation.hasTenantColumn) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: ${qualifiedName} has forced row security or a tenant-isolation policy but no tenant_id column`
      );
    }
    if (!relation.tenantColumnTextNotNull) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: ${qualifiedName}.tenant_id must be a NOT NULL text column`
      );
    }
    if (!relation.rlsEnabled || !relation.rlsForced) {
      throw new TenantDeletionCatalogError(
        `Refusing tenant deletion: ${qualifiedName} must enable and force row-level security`
      );
    }
    assertSupportedPolicies(relation);
    liveTenantTables.add(relation.tableName);
  }

  if (liveTenantTables.size === 0) {
    throw new TenantDeletionCatalogError(
      'Refusing tenant deletion: live-catalog discovery found zero tenant-contract tables'
    );
  }

  // Deferred until the tenant set is complete: an outgoing foreign key is only
  // judgeable once every tenant-contract table is known. The compiled schema is
  // checked for the same property, but only the live catalog sees a constraint
  // added out of band.
  const tenantRelationsByOid = new Map(
    relations
      .filter((relation) => liveTenantTables.has(relation.tableName))
      .map((relation) => [relation.relationId, relation] as const)
  );
  for (const relation of declaredGlobals) {
    assertGlobalReferencesNoTenantTable(relation, tenantRelationsByOid);
  }

  const uncovered = [...liveTenantTables].filter((name) => !planNames.has(name)).sort();
  if (uncovered.length > 0) {
    throw new TenantDeletionCatalogError(
      `Refusing tenant deletion: live tenant table(s) are not covered by the deletion plan: ${uncovered.join(', ')}`
    );
  }

  const fingerprint = JSON.stringify(
    relations.map((relation) => ({
      relationId: relation.relationId,
      schemaName: relation.schemaName,
      tableName: relation.tableName,
      relkind: relation.relkind,
      rlsEnabled: relation.rlsEnabled,
      rlsForced: relation.rlsForced,
      hasTenantColumn: relation.hasTenantColumn,
      tenantColumnTextNotNull: relation.tenantColumnTextNotNull,
      participatesInInheritance: relation.participatesInInheritance,
      // Fingerprinting all incoming/outgoing FK definitions detects timing
      // changes; it does not assert that row values are tenant-consistent.
      foreignKeyContract: relation.foreignKeyContract,
      policies: relation.policies.map((policy) => ({
        name: policy.name,
        command: policy.command,
        permissive: policy.permissive,
        publicOnly: policy.publicOnly,
        roles: policy.roles,
        // Internal parse trees are stable within this live server and avoid a
        // search_path-sensitive deparse in the between-phase fingerprint.
        usingTree: policy.usingTree,
        checkTree: policy.checkTree,
      })),
    }))
  );

  return { liveTenantTables, fingerprint };
}

interface DeletionStep {
  name: string;
  countRows(db: Database, tenantId: string): Promise<number>;
  deleteRows(db: Database, tenantId: string): Promise<void>;
}

const TENANT_SCHEMA = 'public';

function buildQualifiedStep(name: string, tenantColumn: string): DeletionStep {
  const tableIdentifier = sql`${sql.identifier(TENANT_SCHEMA)}.${sql.identifier(name)}`;
  const tenantColumnIdentifier = sql.identifier(tenantColumn);
  return {
    name,
    countRows: async (db, tenantId) => {
      const result = await executeRaw(
        db,
        sql`SELECT pg_catalog.count(*) AS n FROM ${tableIdentifier} WHERE ${tenantColumnIdentifier} = ${tenantId}`
      );
      return Number(rowsOf(result)[0]?.n ?? 0);
    },
    deleteRows: async (db, tenantId) => {
      await executeRaw(
        db,
        sql`DELETE FROM ${tableIdentifier} WHERE ${tenantColumnIdentifier} = ${tenantId}`
      );
    },
  };
}

function buildManifestStep(entry: TenantDeletionTable): DeletionStep {
  return buildQualifiedStep(entry.name, entry.tenantColumn.name);
}

function buildImperativeStep(table: ImperativeTenantTable): DeletionStep {
  return buildQualifiedStep(table.name, table.tenantColumn);
}

interface DeletionPlan {
  steps: DeletionStep[];
  fingerprint: string;
}

async function buildDeletionPlan(
  db: Database,
  manifest: TenantDeletionTable[],
  planNames: ReadonlySet<string>
): Promise<DeletionPlan> {
  const audit = await auditLiveTenantCatalog(db, planNames);
  const presentImperativeTables = IMPERATIVE_TENANT_TABLES.filter((table) =>
    audit.liveTenantTables.has(table.name)
  );
  // Imperative registry entries are deliberately limited to known leaf tables.
  // Their row-level foreign-key consistency remains an operator/schema
  // precondition; the registry does not claim to validate it.
  const steps = [
    ...presentImperativeTables.map(buildImperativeStep),
    ...manifest.map(buildManifestStep),
  ];
  if (steps.length === 0) {
    throw new TenantDeletionCatalogError(
      'Refusing tenant deletion: the reconciled deletion plan is empty'
    );
  }
  return {
    steps,
    fingerprint: JSON.stringify({
      catalog: audit.fingerprint,
      steps: steps.map((step) => step.name),
    }),
  };
}

async function lockDeletionPlan(db: Database, plan: DeletionPlan): Promise<void> {
  for (const step of plan.steps) {
    const tableIdentifier = sql`${sql.identifier(TENANT_SCHEMA)}.${sql.identifier(step.name)}`;
    // SHARE ROW EXCLUSIVE blocks concurrent table writers and policy/DDL changes
    // for the duration of this transaction. It cannot cover a table created
    // after the scan, which is why phase two reconciles the catalog again and
    // operator quiescence remains mandatory.
    await executeRaw(db, sql`LOCK TABLE ${tableIdentifier} IN SHARE ROW EXCLUSIVE MODE`);
  }
}

async function buildLockedDeletionPlan(
  db: Database,
  manifest: TenantDeletionTable[],
  planNames: ReadonlySet<string>
): Promise<DeletionPlan> {
  const beforeLock = await buildDeletionPlan(db, manifest, planNames);
  await lockDeletionPlan(db, beforeLock);
  const afterLock = await buildDeletionPlan(db, manifest, planNames);
  if (beforeLock.fingerprint !== afterLock.fingerprint) {
    throw new TenantDeletionCatalogError(
      'Refusing tenant deletion: the live tenant catalog changed while the deletion plan was being locked'
    );
  }
  return afterLock;
}

async function hardenDeletionSearchPath(db: Database): Promise<void> {
  // Transaction-local and repeated in both phases. Explicit public relation
  // qualification remains the primary binding; this also ensures any incidental
  // built-in function/operator/type resolution prefers pg_catalog and searches
  // the temporary schema last.
  await executeRaw(
    db,
    sql`SELECT pg_catalog.set_config('search_path', 'pg_catalog, public, pg_temp', true)`
  );
}

/**
 * Permanently delete all data for a single tenant, or report what would be
 * deleted when `dryRun` is set. Returns the frozen machine-readable result.
 */
export async function deleteTenantData(
  db: Database,
  tenantId: string,
  options: TenantDeletionOptions = {}
): Promise<TenantDeletionResult | TenantDeletionDryRunResult> {
  assertValidTenantId(tenantId);

  // Refuse to run inside an ambient tenant/system database scope. This routine
  // relies on two independent transactions — phase 1 deletes and commits, phase
  // 2 re-scans committed state. runWithTenantDatabaseScope JOINS an existing
  // scope rather than opening a fresh transaction, so a caller that invokes us
  // within an active scope would collapse both phases into their single
  // uncommitted transaction: verification would then observe uncommitted state
  // and could report success before the outer transaction commits or rolls back.
  if (getCurrentTenantDatabaseScope()) {
    throw new Error(
      'deleteTenantData must run with its own fresh connection, not within an ambient tenant/system database scope.'
    );
  }

  if (!isPostgresDatabase(db)) {
    throw new TenantDeletionUnsupportedError(
      'Tenant deletion requires a PostgreSQL (multi-tenant) database; the SQLite schema is single-tenant'
    );
  }

  const log = options.log ?? (() => {});
  const dryRun = options.dryRun ?? false;
  const manifest = buildTenantDeletionManifest();
  const planNames = new Set([
    ...manifest.map((entry) => entry.name),
    ...IMPERATIVE_TENANT_TABLES.map((table) => table.name),
  ]);
  const startedAt = Date.now();
  const rowCounts: Record<string, number> = {};
  let schemaVersion = '';
  let phaseOneFingerprint = '';
  let phaseOneTableCount = 0;

  // Phase 1: snapshot per-table counts, then (unless this is a dry run) delete,
  // all inside one tenant-scoped transaction so the deletion is atomic. Every
  // statement also has an explicit tenant_id predicate and public-qualified
  // relation; RLS is a separately audited defense, not a foreign-key boundary.
  //
  // Counts are captured up front, BEFORE any DELETE runs. This keeps the reported
  // rowCounts accurate even when an `ON DELETE CASCADE` from a parent table would
  // otherwise remove a child's rows before that child's own DELETE statement
  // runs. Under the tenant-consistent foreign-key precondition, each row belongs
  // to exactly one table and tenant, so the pre-deletion snapshot is precisely
  // the set of rows the operation removes.
  await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await hardenDeletionSearchPath(scoped);
    // Bind the deletion to a continuously-held source write gate when requested.
    // Reading the gate inside this transaction, before locking or deleting,
    // means a lost or replaced gate (writes may have resumed) aborts the whole
    // deletion. The gate record itself lives in a tenant table this deletion will
    // remove, so it is read here first.
    if (options.assertGateGeneration !== undefined) {
      await assertTenantWriteGateGeneration(scoped, tenantId, options.assertGateGeneration);
    }
    schemaVersion = await resolveSchemaVersion(scoped);
    const phaseOnePlan = await buildLockedDeletionPlan(scoped, manifest, planNames);
    phaseOneFingerprint = phaseOnePlan.fingerprint;
    phaseOneTableCount = phaseOnePlan.steps.length;
    log(
      `${dryRun ? 'dry-run: ' : ''}tenant deletion started (schemaVersion=${schemaVersion}, tables=${phaseOneTableCount})`
    );
    for (const step of phaseOnePlan.steps) {
      rowCounts[step.name] = await step.countRows(scoped, tenantId);
      if (rowCounts[step.name] > 0) {
        log(
          `${dryRun ? 'would delete' : 'deleting'} ${rowCounts[step.name]} row(s) from ${step.name}`
        );
      }
    }
    if (dryRun) return;
    for (const step of phaseOnePlan.steps) {
      await step.deleteRows(scoped, tenantId);
    }
  });

  if (!schemaVersion || !phaseOneFingerprint || phaseOneTableCount === 0) {
    throw new TenantDeletionCatalogError(
      'Refusing tenant deletion: phase-one catalog reconciliation did not produce a plan'
    );
  }

  // Phase 2: independently reconcile and lock a fresh plan, compare its live
  // catalog fingerprint to phase one, then verify committed state. Reusing the
  // phase-one steps here would let a relation or policy added between phases
  // escape verification.
  if (!dryRun) {
    const remaining = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      await hardenDeletionSearchPath(scoped);
      const verificationSchemaVersion = await resolveSchemaVersion(scoped);
      if (verificationSchemaVersion !== schemaVersion) {
        throw new TenantDeletionCatalogError(
          'Refusing to certify tenant deletion: the migration watermark changed between deletion and verification'
        );
      }
      const verificationPlan = await buildLockedDeletionPlan(scoped, manifest, planNames);
      if (verificationPlan.fingerprint !== phaseOneFingerprint) {
        throw new TenantDeletionCatalogError(
          'Refusing to certify tenant deletion: the live tenant catalog or verification plan changed after phase one'
        );
      }
      const offending: string[] = [];
      for (const step of verificationPlan.steps) {
        const left = await step.countRows(scoped, tenantId);
        if (left > 0) offending.push(step.name);
      }
      return offending;
    });
    assertNoRemainingTenantRows(remaining);
  }

  const durationMs = Date.now() - startedAt;
  const totalRows = Object.values(rowCounts).reduce((sum, value) => sum + value, 0);
  log(
    `${dryRun ? 'dry-run complete' : 'tenant deletion verified'} (${totalRows} row(s) across ${phaseOneTableCount} tables in ${durationMs}ms)`
  );

  if (dryRun) {
    return { tenantDataDeleted: false, dryRun: true, schemaVersion, rowCounts };
  }
  return { tenantDataDeleted: true, schemaVersion, rowCounts };
}
