import type { Database } from '@agor/core/db';
import {
  executeRaw,
  isPostgresDatabaseHandle,
  runDatabaseTransaction,
  runWithSystemDatabaseScope,
  sql,
} from '@agor/core/db';
import type { TenantRuntimeBootstrapPayload } from './tenant-runtime-bootstrap.js';

const IDENTITY_KEY = 'primary';
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/;

export type TenantRuntimeCurrentAuthorityErrorCode = 'missing' | 'invalid' | 'binding_mismatch';

/** A read-only proof of the deployment-owned identity stored in the connected DB. */
export interface TenantRuntimeCurrentAuthority {
  readonly identityKey: typeof IDENTITY_KEY;
  readonly protocolVersion: 1;
  readonly deploymentId: string;
  readonly databaseIncarnationId: string;
  readonly databaseName: string;
  readonly logicalDatabaseId: string;
  readonly teamId: string;
  readonly placementId: string;
  readonly placementRevision: number;
  readonly placementOrigin: string;
}

export class TenantRuntimeCurrentAuthorityError extends Error {
  constructor(
    public readonly code: TenantRuntimeCurrentAuthorityErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TenantRuntimeCurrentAuthorityError';
  }
}

function fail(code: TenantRuntimeCurrentAuthorityErrorCode, message: string): never {
  throw new TenantRuntimeCurrentAuthorityError(code, message);
}

function rows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const value = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail('invalid', `Runtime installation identity ${name} is invalid`);
  }
  return value;
}

function databaseName(value: unknown): string {
  if (typeof value !== 'string' || !DATABASE_NAME_PATTERN.test(value)) {
    fail('invalid', 'Runtime installation identity database name is invalid');
  }
  return value;
}

function revision(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    fail('invalid', 'Runtime installation identity placement revision is invalid');
  }
  return parsed;
}

function parseIdentity(row: Record<string, unknown>): TenantRuntimeCurrentAuthority {
  if (row.identity_key !== IDENTITY_KEY || row.protocol_version !== 1) {
    fail('invalid', 'Runtime installation identity protocol or key is invalid');
  }
  return {
    identityKey: IDENTITY_KEY,
    protocolVersion: 1,
    deploymentId: identifier(row.deployment_id, 'deployment_id'),
    databaseIncarnationId: identifier(row.database_incarnation_id, 'database_incarnation_id'),
    databaseName: databaseName(row.database_name),
    logicalDatabaseId: identifier(row.logical_database_id, 'logical_database_id'),
    teamId: identifier(row.team_id, 'team_id'),
    placementId: identifier(row.placement_id, 'placement_id'),
    placementRevision: revision(row.placement_revision),
    placementOrigin:
      typeof row.placement_origin === 'string'
        ? row.placement_origin
        : fail('invalid', 'Runtime installation identity placement origin is invalid'),
  };
}

function assertMatches(
  authority: TenantRuntimeCurrentAuthority,
  bootstrap: TenantRuntimeBootstrapPayload
): void {
  const checks: Array<[string, string, string]> = [
    ['deployment identity', authority.deploymentId, bootstrap.deployment_id],
    ['database incarnation', authority.databaseIncarnationId, bootstrap.database_incarnation_id],
    ['database name', authority.databaseName, bootstrap.database_name],
    ['logical database identity', authority.logicalDatabaseId, bootstrap.logical_database_id],
    ['team identity', authority.teamId, bootstrap.team_id],
    ['placement identity', authority.placementId, bootstrap.placement_id],
    ['placement origin', authority.placementOrigin, bootstrap.placement_origin],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) {
      fail('binding_mismatch', `Connected runtime identity does not match bootstrap ${label}`);
    }
  }
  if (authority.placementRevision !== bootstrap.placement_revision) {
    fail(
      'binding_mismatch',
      'Connected runtime identity does not match bootstrap placement revision'
    );
  }
}

/**
 * Read and lock the singleton identity from the connected database. This
 * adapter never creates, repairs, or replaces the row. A separate privileged
 * installer must seed/rebind it under an expected-incarnation fence.
 */
export async function verifyTenantRuntimeCurrentAuthority(
  db: Database,
  bootstrap: TenantRuntimeBootstrapPayload
): Promise<TenantRuntimeCurrentAuthority> {
  return runWithSystemDatabaseScope(db, 'tenant runtime current authority', async (systemDb) => {
    // Managed runtime identity is deliberately PostgreSQL-only in this
    // adapter. SQLite has no stable deployment/database identity that can be
    // compared to the signed control-plane contract (file paths and
    // `:memory:` are not portable identifiers), so a configured managed
    // runtime must refuse it rather than silently weaken the binding.
    if (!isPostgresDatabaseHandle(systemDb)) {
      fail(
        'invalid',
        'Managed tenant runtime current authority requires PostgreSQL; SQLite is unsupported'
      );
    }

    // Keep the row lock and the connected-database metadata read in one
    // explicit transaction. Without this, PostgreSQL releases `FOR SHARE`
    // at the end of the first statement and a pooled connection could change
    // between the two observations.
    return runDatabaseTransaction(systemDb, async (tx) => {
      const query = sql`
        SELECT identity_key, protocol_version, deployment_id, database_incarnation_id,
               database_name, logical_database_id, team_id, placement_id,
               placement_revision, placement_origin
        FROM public.runtime_installation_identity
        ORDER BY identity_key
        FOR SHARE
      `;
      const found = rows(await executeRaw(tx, query));
      if (found.length === 0) {
        fail('missing', 'Connected database has no runtime installation identity');
      }
      if (found.length !== 1) {
        fail('invalid', 'Connected database has an ambiguous runtime installation identity');
      }
      const authority = parseIdentity(found[0]!);
      assertMatches(authority, bootstrap);
      // `logical_database_id` is an opaque control-plane identifier and is not
      // a PostgreSQL catalog OID: OIDs are cluster-local and can be reused.
      // The connected physical database name is checked independently; clone
      // detection/physical identity needs a future controller-issued proof.
      const metadataQuery = sql`SELECT current_database() AS database_name`;
      const metadata = rows(await executeRaw(tx, metadataQuery));
      if (metadata.length !== 1) {
        fail('invalid', 'Connected database identity metadata is missing or ambiguous');
      }
      const actualDatabaseName = databaseName(metadata[0]!.database_name);
      if (authority.databaseName !== actualDatabaseName) {
        fail(
          'binding_mismatch',
          'Connected PostgreSQL database name does not match its installation identity'
        );
      }
      return authority;
    });
  });
}
