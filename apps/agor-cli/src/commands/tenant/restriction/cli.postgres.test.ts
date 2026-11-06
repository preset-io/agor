/** End-to-end `agor tenant restriction apply|inspect` in a child process with only DATABASE_URL, as the in-Cell Job runs them. */

import {
  createDatabase,
  type Database,
  readTenantRestrictionState,
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

    // Transition, replay and conflict rules are proven in core; this pins the process contract.
    it('applies with exit 0 and one JSON line, replays as a no-op, and maps a conflict to exit 2', async () => {
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
      expect((await readTenantRestrictionState(db, tenant)).records).toEqual([
        restrictedPayload.record,
      ]);

      // A retried Job must not look like a new transition.
      const retried = await apply(tenant, 'susp-1', 1, 'restrict');
      expect(retried.code).toBe(0);
      expect((JSON.parse(retried.stdout) as ApplyPayload).changed).toBe(false);

      expect((await apply(tenant, 'rel-2', 2, 'prepare_release')).code).toBe(0);
      const stale = await apply(tenant, 'susp-1', 1, 'restrict');
      expect(stale.code).toBe(2);
      expect(stale.stdout).toBe('');
      expect(stale.stderr).toContain('{"error":"stale_revision"}');

      const inspected = await runTenantRestrictionCli(['inspect', '--tenant-id', tenant], jobEnv());
      expect(inspected.code).toBe(0);
      expect(JSON.parse(inspected.stdout)).toEqual([
        {
          ...restrictedPayload.record,
          operationId: 'rel-2',
          revision: 2,
          phase: 'release_prepared',
        },
      ]);
      const cutoff = (await readTenantRestrictionState(db, tenant)).resumeAfter!;
      expect(inspected.stderr).toContain(
        `Event cutoff (latest update): ${new Date(cutoff).toISOString()}`
      );
    }, 180_000);

    it('inspects an unrecorded tenant as [] without a row, then seeds it with a warning only when changed', async () => {
      const tenant = `cli-restriction-seed-${Date.now().toString(36)}`;
      const empty = await runTenantRestrictionCli(['inspect', '--tenant-id', tenant], jobEnv());
      expect(empty.code).toBe(0);
      expect(JSON.parse(empty.stdout)).toEqual([]);
      expect((await readTenantRestrictionState(db, tenant)).records).toEqual([]);

      const seeded = await apply(tenant, 'reactivate-4', 4, 'seed_active');
      expect(seeded.code).toBe(0);
      expect(seeded.stderr).toContain('credential generation changed');
      expect(JSON.parse(seeded.stdout)).toMatchObject({
        record: { operationId: 'reactivate-4', revision: 4, phase: 'active' },
        changed: true,
      });

      // A rerun Job (lost report, expired or re-leased lease) must read as an accepted no-op.
      const replayed = await apply(tenant, 'reactivate-4', 4, 'seed_active');
      expect(replayed.code).toBe(0);
      expect((JSON.parse(replayed.stdout) as ApplyPayload).changed).toBe(false);
      expect(replayed.stderr).not.toContain('credential generation changed');
    }, 180_000);
  }
);
