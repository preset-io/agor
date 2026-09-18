/** Real PostgreSQL coverage for the managed runtime identity adapter. */

import {
  createDatabase,
  type Database,
  executeRaw,
  initializeDatabase,
  rawRows,
  runDatabaseTransaction,
  sql,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantRuntimeBootstrapPayload } from './tenant-runtime-bootstrap.js';
import { verifyTenantRuntimeCurrentAuthority } from './tenant-runtime-current-authority.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgres = process.env.AGOR_DB_DIALECT === 'postgresql';

function bootstrap(databaseName: string): TenantRuntimeBootstrapPayload {
  return {
    kind: 'agor.tenant-runtime-bootstrap',
    version: 1,
    deployment_id: '019c1234-5678-7123-8123-123456789abc',
    database_incarnation_id: 'real-pg-incarnation',
    database_name: databaseName,
    // This is deliberately opaque and is not a pg_database OID.
    logical_database_id: 'control-plane-db-real-pg',
    team_id: 'team-real-pg',
    placement_id: 'placement-real-pg',
    placement_revision: 11,
    placement_origin: 'https://runtime.example.test/real-pg',
    replica_inventory: [{ replica_id: 'replica-real-pg', incarnation_id: 'replica-incarnation' }],
    restore_policy: 'closed',
    issued_at: '2026-09-16T12:00:00.000Z',
  };
}

function identity(payload: TenantRuntimeBootstrapPayload) {
  return {
    identity_key: 'primary',
    protocol_version: 1,
    deployment_id: payload.deployment_id,
    database_incarnation_id: payload.database_incarnation_id,
    database_name: payload.database_name,
    logical_database_id: payload.logical_database_id,
    team_id: payload.team_id,
    placement_id: payload.placement_id,
    placement_revision: payload.placement_revision,
    placement_origin: payload.placement_origin,
  };
}

async function insertIdentity(db: Database, row: ReturnType<typeof identity>): Promise<void> {
  await executeRaw(
    db,
    sql`INSERT INTO public.runtime_installation_identity (
      identity_key, protocol_version, deployment_id, database_incarnation_id,
      database_name, logical_database_id, team_id, placement_id,
      placement_revision, placement_origin
    ) VALUES (
      ${row.identity_key}, ${row.protocol_version}, ${row.deployment_id},
      ${row.database_incarnation_id}, ${row.database_name}, ${row.logical_database_id},
      ${row.team_id}, ${row.placement_id}, ${row.placement_revision}, ${row.placement_origin}
    )`
  );
}

describe.skipIf(!postgresUrl || !usesPostgres)(
  'tenant runtime current authority (PostgreSQL)',
  () => {
    let db: Database;
    let writerDb: Database;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      writerDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    }, 60_000);

    afterAll(async () => {
      if (db) {
        await Promise.all([
          (db as Database & { $client: { end: () => Promise<void> } }).$client.end(),
          (writerDb as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        ]);
      }
    });

    async function withCommittedIdentity<T>(
      payload: TenantRuntimeBootstrapPayload,
      work: (root: Database) => Promise<T>
    ): Promise<T> {
      const previous = rawRows(
        await executeRaw(
          db,
          sql`SELECT identity_key, protocol_version, deployment_id, database_incarnation_id,
                     database_name, logical_database_id, team_id, placement_id,
                     placement_revision, placement_origin
              FROM public.runtime_installation_identity
              ORDER BY identity_key`
        )
      ) as Array<ReturnType<typeof identity>>;
      try {
        await executeRaw(db, sql`DELETE FROM public.runtime_installation_identity`);
        await insertIdentity(db, identity(payload));
        return await work(db);
      } finally {
        await executeRaw(db, sql`DELETE FROM public.runtime_installation_identity`);
        for (const row of previous) {
          await insertIdentity(db, row);
        }
      }
    }

    it('holds the row lock through metadata validation on a root-handle invocation', async () => {
      const metadata = rawRows(
        await executeRaw(db, sql`SELECT current_database() AS database_name`)
      );
      const databaseName = String((metadata[0] as { database_name?: unknown })?.database_name);
      const signed = bootstrap(databaseName);

      await withCommittedIdentity(signed, async (root) => {
        let releaseIdentityRead!: () => void;
        const identityReadHeld = new Promise<void>((resolve) => {
          releaseIdentityRead = resolve;
        });
        let identityReadObserved!: () => void;
        const identityRead = new Promise<void>((resolve) => {
          identityReadObserved = resolve;
        });

        const actualRoot = root as unknown as {
          transaction: (
            work: (tx: unknown) => Promise<unknown>,
            config?: unknown
          ) => Promise<unknown>;
        };
        const guardedRoot = {
          transaction: (work: (tx: unknown) => Promise<unknown>, config?: unknown) =>
            actualRoot.transaction(async (tx) => {
              let executeCount = 0;
              const guardedTx = {
                execute: async (query: unknown) => {
                  const result = await (
                    tx as { execute: (query: unknown) => Promise<unknown> }
                  ).execute(query);
                  executeCount += 1;
                  if (executeCount === 1) {
                    identityReadObserved();
                    await identityReadHeld;
                  }
                  return result;
                },
              };
              return work(guardedTx);
            }, config),
        } as unknown as Database;

        let verification: Promise<unknown> | undefined;
        try {
          const pendingVerification = verifyTenantRuntimeCurrentAuthority(guardedRoot, signed);
          verification = pendingVerification;
          // Keep a rejection handler attached while the identity-read rendezvous
          // is intentionally paused; an early adapter error must not become an
          // unhandled rejection before the bounded wait completes.
          void pendingVerification.catch(() => undefined);
          let identityReadTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              identityRead,
              new Promise<never>((_, reject) => {
                identityReadTimeout = setTimeout(
                  () => reject(new Error('Timed out waiting for identity row lock rendezvous')),
                  5_000
                );
              }),
            ]);
          } finally {
            if (identityReadTimeout) clearTimeout(identityReadTimeout);
          }

          const writer = runDatabaseTransaction(writerDb, async (tx) => {
            await executeRaw(tx, sql`SET LOCAL lock_timeout = '250ms'`);
            await executeRaw(
              tx,
              sql`UPDATE public.runtime_installation_identity
                  SET updated_at = now()
                  WHERE identity_key = 'primary'`
            );
          });
          await expect(writer).rejects.toMatchObject({ code: '55P03' });
          releaseIdentityRead();
          await expect(pendingVerification).resolves.toMatchObject({
            databaseName,
            logicalDatabaseId: signed.logical_database_id,
          });
        } finally {
          releaseIdentityRead();
          if (verification) await verification.catch(() => undefined);
        }
      });
    });

    it('checks the connected PostgreSQL database name while preserving an opaque logical ID', async () => {
      const metadata = rawRows(
        await executeRaw(db, sql`SELECT current_database() AS database_name`)
      );
      const databaseName = String((metadata[0] as { database_name?: unknown })?.database_name);
      const signed = bootstrap(databaseName);

      await withCommittedIdentity(signed, async (root) => {
        await expect(verifyTenantRuntimeCurrentAuthority(root, signed)).resolves.toMatchObject({
          databaseName,
          logicalDatabaseId: signed.logical_database_id,
          placementRevision: signed.placement_revision,
        });
      });
    });

    it('rejects an identity whose signed database name differs from the connected database', async () => {
      const metadata = rawRows(
        await executeRaw(db, sql`SELECT current_database() AS database_name`)
      );
      const databaseName = String((metadata[0] as { database_name?: unknown })?.database_name);
      const signed = bootstrap('different-runtime-name');

      await withCommittedIdentity(signed, async (root) => {
        await expect(verifyTenantRuntimeCurrentAuthority(root, signed)).rejects.toMatchObject({
          name: 'TenantRuntimeCurrentAuthorityError',
          code: 'binding_mismatch',
          message: 'Connected PostgreSQL database name does not match its installation identity',
        });
        expect(databaseName).not.toBe(signed.database_name);
      });
    });
  }
);
