/**
 * End-to-end contract for `agor tenant restriction apply|inspect` against the
 * isolated PostgreSQL database: the commands run in a real child process with
 * only DATABASE_URL set and no daemon, exactly as the in-Cell Job invokes them.
 */

import {
  createDatabase,
  type Database,
  readTenantRestrictionIntents,
  runMigrations,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTenantRestrictionCli } from '../../../lib/tenant-restriction.test-support.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgres = process.env.AGOR_DB_DIALECT === 'postgresql';

const CONTROLLER = 'agor-cloud-team-suspension-v1';
const PLACEMENT = 'cell-7';

interface ApplyPayload {
  record: {
    version: number;
    controllerId: string;
    placementId: string;
    operationId: string;
    revision: number;
    phase: string;
  };
  changed: boolean;
}

describe.skipIf(!postgresUrl || !usesPostgres)(
  'agor tenant restriction apply|inspect (PostgreSQL)',
  () => {
    let db: Database;

    /** Only DATABASE_URL — the acceptance is that nothing else is required. */
    const jobEnv = () => ({ DATABASE_URL: postgresUrl as string });

    const apply = (
      tenantId: string,
      operationId: string,
      revision: number,
      action: string,
      overrides: { controllerId?: string; placementId?: string } = {}
    ) =>
      runTenantRestrictionCli(
        [
          'apply',
          '--tenant-id',
          tenantId,
          '--controller-id',
          overrides.controllerId ?? CONTROLLER,
          '--placement-id',
          overrides.placementId ?? PLACEMENT,
          '--operation-id',
          operationId,
          '--revision',
          String(revision),
          '--action',
          action,
        ],
        jobEnv()
      );

    beforeAll(async () => {
      db = createDatabase({ url: postgresUrl as string });
      await runMigrations(db);
    }, 120_000);

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('records restrict → prepare_release → activate, repeats as no-ops, and refuses a stale revision', async () => {
      const tenant = `cli-restriction-${Date.now().toString(36)}`;

      const restricted = await apply(tenant, 'susp-1', 1, 'restrict');
      expect(restricted.code).toBe(0);
      const restrictedPayload = JSON.parse(restricted.stdout) as ApplyPayload;
      expect(restrictedPayload).toEqual({
        record: {
          version: 1,
          controllerId: CONTROLLER,
          placementId: PLACEMENT,
          operationId: 'susp-1',
          revision: 1,
          phase: 'restricted',
        },
        changed: true,
      });
      expect(await readTenantRestrictionIntents(db, tenant)).toEqual([restrictedPayload.record]);

      // A retried Job must not look like a new transition.
      const retried = await apply(tenant, 'susp-1', 1, 'restrict');
      expect(retried.code).toBe(0);
      expect((JSON.parse(retried.stdout) as ApplyPayload).changed).toBe(false);

      const prepared = await apply(tenant, 'rel-2', 2, 'prepare_release');
      expect(prepared.code).toBe(0);
      const preparedPayload = JSON.parse(prepared.stdout) as ApplyPayload;
      expect(preparedPayload.changed).toBe(true);
      expect(preparedPayload.record.phase).toBe('release_prepared');
      // Preparing a release does not open admission.
      expect(await readTenantRestrictionIntents(db, tenant)).toEqual([preparedPayload.record]);

      const activated = await apply(tenant, 'rel-2', 2, 'activate');
      expect(activated.code).toBe(0);
      const activatedPayload = JSON.parse(activated.stdout) as ApplyPayload;
      expect(activatedPayload).toEqual({
        record: {
          version: 1,
          controllerId: CONTROLLER,
          placementId: PLACEMENT,
          operationId: 'rel-2',
          revision: 2,
          phase: 'active',
        },
        changed: true,
      });
      expect(await readTenantRestrictionIntents(db, tenant)).toEqual([activatedPayload.record]);

      // The activated revision is a watermark: a delayed restrict at an older
      // revision is rejected with a machine-readable conflict code.
      const stale = await apply(tenant, 'susp-1', 1, 'restrict');
      expect(stale.code).toBe(2);
      expect(stale.stdout).toBe('');
      expect(stale.stderr).toContain('{"error":"stale_revision"}');
      expect(await readTenantRestrictionIntents(db, tenant)).toEqual([activatedPayload.record]);

      const inspected = await runTenantRestrictionCli(['inspect', '--tenant-id', tenant], jobEnv());
      expect(inspected.code).toBe(0);
      expect(JSON.parse(inspected.stdout)).toEqual([activatedPayload.record]);
    }, 180_000);

    it('reads an unrecorded tenant as an empty array without creating a row', async () => {
      const tenant = `cli-restriction-empty-${Date.now().toString(36)}`;
      const inspected = await runTenantRestrictionCli(['inspect', '--tenant-id', tenant], jobEnv());

      expect(inspected.code).toBe(0);
      expect(JSON.parse(inspected.stdout)).toEqual([]);
      expect(await readTenantRestrictionIntents(db, tenant)).toEqual([]);
    }, 60_000);

    it('refuses a second controller identity for a recorded placement', async () => {
      const tenant = `cli-restriction-identity-${Date.now().toString(36)}`;
      expect((await apply(tenant, 'susp-1', 1, 'restrict')).code).toBe(0);

      const mismatched = await apply(tenant, 'susp-2', 2, 'restrict', {
        placementId: 'cell-other',
      });

      expect(mismatched.code).toBe(2);
      expect(mismatched.stderr).toContain('{"error":"identity_mismatch"}');
    }, 120_000);
  }
);
