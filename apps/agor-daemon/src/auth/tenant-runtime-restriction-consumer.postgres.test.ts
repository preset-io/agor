/** Real PostgreSQL coverage for the authenticated runtime restriction consumer. */

import { generateKeyPairSync, sign } from 'node:crypto';
import {
  assertTenantUnrestricted,
  createDatabase,
  type Database,
  generateId,
  initializeDatabase,
  readTenantRestrictionIntents,
  runWithTenantDatabaseScope,
  TenantRestrictedError,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantRuntimeBootstrapPayload } from './tenant-runtime-bootstrap.js';
import type { TenantRuntimeCurrentAuthority } from './tenant-runtime-current-authority.js';
import {
  canonicalizeSignedTenantRuntimeRestrictionCommand,
  type SignedTenantRuntimeRestrictionCommand,
  type TenantRuntimeRestrictionCommandPayload,
} from './tenant-runtime-restriction-command.js';
import {
  consumeTenantRuntimeRestrictionCommand,
  type TenantRuntimeRestrictionTenantBinding,
  type TenantRuntimeRestrictionTenantResolver,
} from './tenant-runtime-restriction-consumer.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgres = process.env.AGOR_DB_DIALECT === 'postgresql';
const DEPLOYMENT_ID = '019c1234-5678-7123-8123-123456789abc';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

const bootstrap: TenantRuntimeBootstrapPayload = {
  kind: 'agor.tenant-runtime-bootstrap',
  version: 1,
  deployment_id: DEPLOYMENT_ID,
  database_incarnation_id: 'db-incarnation-consumer',
  database_name: 'agor-runtime',
  logical_database_id: 'logical-db-consumer',
  team_id: 'team-consumer',
  placement_id: 'placement-consumer',
  placement_revision: 7,
  placement_origin: 'https://runtime.example.test/cell-consumer',
  replica_inventory: [
    { replica_id: 'replica-consumer', incarnation_id: 'replica-incarnation-consumer' },
  ],
  restore_policy: 'closed',
  issued_at: '2026-09-16T12:00:00.000Z',
};

const currentAuthority: TenantRuntimeCurrentAuthority = {
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
};

function payload(
  overrides: Partial<TenantRuntimeRestrictionCommandPayload> = {}
): TenantRuntimeRestrictionCommandPayload {
  return {
    kind: 'agor.tenant-runtime-restriction-command',
    version: 1,
    tenant_id: 'workspace-consumer',
    deployment_id: bootstrap.deployment_id,
    database_incarnation_id: bootstrap.database_incarnation_id,
    database_name: bootstrap.database_name,
    logical_database_id: bootstrap.logical_database_id,
    team_id: bootstrap.team_id,
    placement_id: bootstrap.placement_id,
    placement_origin: bootstrap.placement_origin,
    placement_revision: bootstrap.placement_revision,
    controller_id: 'agor-cloud-team-suspension-v1',
    operation_id: 'team-suspension-consumer-operation',
    revision: 1,
    action: 'restrict',
    issued_at: '2026-09-16T12:01:00.000Z',
    ...overrides,
  };
}

function signedCommand(
  commandPayload: TenantRuntimeRestrictionCommandPayload
): SignedTenantRuntimeRestrictionCommand {
  const keyId = 'cloud-key-consumer';
  const signature = sign(
    null,
    Buffer.from(canonicalizeSignedTenantRuntimeRestrictionCommand(keyId, commandPayload), 'utf8'),
    privateKey
  ).toString('base64url');
  return { key_id: keyId, payload: commandPayload, signature };
}

function bindingFor(
  commandPayload: TenantRuntimeRestrictionCommandPayload,
  overrides: Partial<TenantRuntimeRestrictionTenantBinding> = {}
): TenantRuntimeRestrictionTenantBinding {
  return {
    workspaceId: commandPayload.tenant_id,
    tenantId: commandPayload.tenant_id,
    teamId: commandPayload.team_id,
    deploymentId: commandPayload.deployment_id,
    databaseIncarnationId: commandPayload.database_incarnation_id,
    databaseName: commandPayload.database_name,
    logicalDatabaseId: commandPayload.logical_database_id,
    placementId: commandPayload.placement_id,
    placementOrigin: commandPayload.placement_origin,
    placementRevision: commandPayload.placement_revision,
    ...overrides,
  };
}

function consumerInput(
  db: Database,
  commandPayload: TenantRuntimeRestrictionCommandPayload,
  resolveTenant: TenantRuntimeRestrictionTenantResolver = async ({ tenantId, payload }) =>
    bindingFor(payload, { tenantId, workspaceId: tenantId })
) {
  return {
    db,
    raw: signedCommand(commandPayload),
    publicKey: publicKeyPem,
    expectations: {
      bootstrap,
      currentAuthority,
      expectedKeyId: 'cloud-key-consumer',
      expectedControllerId: 'agor-cloud-team-suspension-v1',
    },
    resolveTenant,
  };
}

async function close(db: Database): Promise<void> {
  await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
}

describe.skipIf(!postgresUrl || !usesPostgres)(
  'tenant runtime restriction authenticated consumer (PostgreSQL; skipped when unavailable)',
  () => {
    let db: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    }, 60_000);

    afterAll(async () => {
      if (db) await close(db);
    });

    it('applies valid restrict and prepare_release commands while keeping release closed', async () => {
      const tenantId = `consumer-valid-${generateId()}`;
      const restrictPayload = payload({
        tenant_id: tenantId,
        operation_id: 'consumer-restrict-operation',
      });
      const restricted = await consumeTenantRuntimeRestrictionCommand(
        consumerInput(db, restrictPayload)
      );
      expect(restricted).toMatchObject({
        keyId: 'cloud-key-consumer',
        tenantId,
        payload: restrictPayload,
        command: {
          controllerId: restrictPayload.controller_id,
          placementId: restrictPayload.placement_id,
          operationId: restrictPayload.operation_id,
          revision: restrictPayload.revision,
          action: 'restrict',
        },
        record: {
          controllerId: restrictPayload.controller_id,
          placementId: restrictPayload.placement_id,
          operationId: restrictPayload.operation_id,
          revision: restrictPayload.revision,
          phase: 'restricted',
        },
        changed: true,
      });
      await expect(assertTenantUnrestricted(db, tenantId)).rejects.toBeInstanceOf(
        TenantRestrictedError
      );

      const releasePayload = payload({
        tenant_id: tenantId,
        operation_id: 'consumer-release-operation',
        revision: 2,
        action: 'prepare_release',
      });
      const prepared = await consumeTenantRuntimeRestrictionCommand(
        consumerInput(db, releasePayload)
      );
      expect(prepared).toMatchObject({
        payload: releasePayload,
        command: {
          operationId: releasePayload.operation_id,
          revision: 2,
          action: 'prepare_release',
        },
        record: {
          operationId: releasePayload.operation_id,
          revision: 2,
          phase: 'release_prepared',
        },
        changed: true,
      });
      await expect(assertTenantUnrestricted(db, tenantId)).rejects.toBeInstanceOf(
        TenantRestrictedError
      );
    });

    it('makes same-command retries no-ops and rejects stale or conflicting operation revisions', async () => {
      const tenantId = `consumer-replay-${generateId()}`;
      const firstPayload = payload({
        tenant_id: tenantId,
        operation_id: 'consumer-replay-operation',
      });
      const first = await consumeTenantRuntimeRestrictionCommand(consumerInput(db, firstPayload));
      const retry = await consumeTenantRuntimeRestrictionCommand(consumerInput(db, firstPayload));
      expect(retry).toMatchObject({ record: first.record, changed: false });

      await expect(
        consumeTenantRuntimeRestrictionCommand(
          consumerInput(
            db,
            payload({
              tenant_id: tenantId,
              operation_id: 'consumer-conflicting-operation',
            })
          )
        )
      ).rejects.toMatchObject({
        name: 'TenantRestrictionConflictError',
        code: 'revision_conflict',
      });

      const releasePayload = payload({
        tenant_id: tenantId,
        operation_id: 'consumer-replay-release',
        revision: 2,
        action: 'prepare_release',
      });
      await consumeTenantRuntimeRestrictionCommand(consumerInput(db, releasePayload));

      await expect(
        consumeTenantRuntimeRestrictionCommand(
          consumerInput(
            db,
            payload({
              tenant_id: tenantId,
              operation_id: 'consumer-stale-operation',
              revision: 1,
            })
          )
        )
      ).rejects.toMatchObject({ name: 'TenantRestrictionConflictError', code: 'stale_revision' });
      expect(await readTenantRestrictionIntents(db, tenantId)).toEqual([
        expect.objectContaining({
          operationId: releasePayload.operation_id,
          revision: releasePayload.revision,
          phase: 'release_prepared',
        }),
      ]);
    });

    it('does not mutate when the authoritative binding is missing or moved', async () => {
      const missingTenant = `consumer-missing-${generateId()}`;
      await expect(
        consumeTenantRuntimeRestrictionCommand(
          consumerInput(db, payload({ tenant_id: missingTenant }), async () => null)
        )
      ).rejects.toMatchObject({ code: 'tenant_binding_unavailable' });
      await expect(readTenantRestrictionIntents(db, missingTenant)).resolves.toEqual([]);

      const movedTenant = `consumer-moved-${generateId()}`;
      const movedPayload = payload({ tenant_id: movedTenant });
      await expect(
        consumeTenantRuntimeRestrictionCommand(
          consumerInput(db, movedPayload, async ({ payload: resolvedPayload }) =>
            bindingFor(resolvedPayload, { placementId: 'replacement-placement' })
          )
        )
      ).rejects.toMatchObject({ code: 'tenant_binding_mismatch' });
      await expect(readTenantRestrictionIntents(db, movedTenant)).resolves.toEqual([]);
    });

    it('rolls back a consumer mutation with its surrounding database transaction', async () => {
      const tenantId = `consumer-rollback-${generateId()}`;
      await expect(
        runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          await consumeTenantRuntimeRestrictionCommand(
            consumerInput(
              scoped,
              payload({ tenant_id: tenantId, operation_id: 'consumer-rollback-operation' })
            )
          );
          throw new Error('consumer-transaction-failure');
        })
      ).rejects.toThrow('consumer-transaction-failure');
      await expect(readTenantRestrictionIntents(db, tenantId)).resolves.toEqual([]);
    });
  }
);
