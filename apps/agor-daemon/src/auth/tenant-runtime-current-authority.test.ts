import { describe, expect, it, vi } from 'vitest';
import type { TenantRuntimeBootstrapPayload } from './tenant-runtime-bootstrap.js';
import {
  type TenantRuntimeCurrentAuthorityError,
  verifyTenantRuntimeCurrentAuthority,
} from './tenant-runtime-current-authority.js';

const bootstrap: TenantRuntimeBootstrapPayload = {
  kind: 'agor.tenant-runtime-bootstrap',
  version: 1,
  deployment_id: '019c1234-5678-7123-8123-123456789abc',
  database_incarnation_id: 'db-incarnation-a',
  database_name: 'agor-runtime',
  logical_database_id: 'pg-oid-123',
  team_id: 'team-a',
  placement_id: 'placement-a',
  placement_revision: 7,
  placement_origin: 'https://runtime.example.test/cell-a',
  replica_inventory: [{ replica_id: 'replica-a', incarnation_id: 'replica-incarnation-a' }],
  restore_policy: 'closed',
  issued_at: '2026-09-16T12:00:00.000Z',
};

function databaseWithRows(
  identityRows: unknown[],
  metadataRows: unknown[] = [{ database_name: bootstrap.database_name }]
) {
  let call = 0;
  const fake = {
    execute: vi.fn(async () => ({ rows: call++ === 0 ? identityRows : metadataRows })),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work(fake),
  };
  return fake as never;
}

function sqliteDatabase() {
  return { run: vi.fn() } as never;
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    identity_key: 'primary',
    protocol_version: 1,
    deployment_id: bootstrap.deployment_id,
    database_incarnation_id: bootstrap.database_incarnation_id,
    database_name: bootstrap.database_name,
    logical_database_id: bootstrap.logical_database_id,
    team_id: bootstrap.team_id,
    placement_id: bootstrap.placement_id,
    placement_revision: bootstrap.placement_revision,
    placement_origin: bootstrap.placement_origin,
    ...overrides,
  };
}

describe('tenant runtime current authority', () => {
  it('reads the connected singleton and matches every bootstrap binding', async () => {
    const db = databaseWithRows([identity()]);
    await expect(verifyTenantRuntimeCurrentAuthority(db, bootstrap)).resolves.toMatchObject({
      identityKey: 'primary',
      protocolVersion: 1,
      deploymentId: bootstrap.deployment_id,
      databaseIncarnationId: bootstrap.database_incarnation_id,
      databaseName: bootstrap.database_name,
      logicalDatabaseId: bootstrap.logical_database_id,
      teamId: bootstrap.team_id,
      placementId: bootstrap.placement_id,
      placementRevision: bootstrap.placement_revision,
      placementOrigin: bootstrap.placement_origin,
    });
  });

  it.each([
    ['missing row', [], 'missing'],
    [
      'copied database incarnation',
      [identity({ database_incarnation_id: 'db-clone' })],
      'binding_mismatch',
    ],
    ['wrong team placement', [identity({ team_id: 'team-b' })], 'binding_mismatch'],
    ['invalid protocol', [identity({ protocol_version: 2 })], 'invalid'],
    ['unsafe revision', [identity({ placement_revision: Number.MAX_SAFE_INTEGER + 1 })], 'invalid'],
  ] as const)('%s fails closed', async (_label, rows, code) => {
    await expect(
      verifyTenantRuntimeCurrentAuthority(databaseWithRows(rows), bootstrap)
    ).rejects.toMatchObject({
      name: 'TenantRuntimeCurrentAuthorityError',
      code,
    } satisfies Partial<TenantRuntimeCurrentAuthorityError>);
  });

  it('rejects a copied identity row on a different connected database', async () => {
    await expect(
      verifyTenantRuntimeCurrentAuthority(
        databaseWithRows([identity()], [{ database_name: 'other-runtime' }]),
        bootstrap
      )
    ).rejects.toMatchObject({
      name: 'TenantRuntimeCurrentAuthorityError',
      code: 'binding_mismatch',
    } satisfies Partial<TenantRuntimeCurrentAuthorityError>);
  });

  it('refuses managed SQLite rather than using an unstable file identity', async () => {
    await expect(
      verifyTenantRuntimeCurrentAuthority(sqliteDatabase(), bootstrap)
    ).rejects.toMatchObject({
      name: 'TenantRuntimeCurrentAuthorityError',
      code: 'invalid',
      message:
        'Managed tenant runtime current authority requires PostgreSQL; SQLite is unsupported',
    } satisfies Partial<TenantRuntimeCurrentAuthorityError>);
  });
});
