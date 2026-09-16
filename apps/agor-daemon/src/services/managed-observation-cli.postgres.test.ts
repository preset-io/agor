/** Actual operator helper + non-owner PG. No existing database or provider access. */
import { readManagedOAuthSchemaDigest, runWithTenantDatabaseScope } from '@agor/core/db';
import { MCPManagedOAuthDatabaseObservationReportSchema } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedManagedRefreshGrant } from '../../../../packages/core/src/db/test-support/managed-oauth-fixture';
import {
  createOwnedPostgres,
  type OwnedPostgres,
} from '../../../../packages/core/src/db/test-support/owned-postgres';
import { observeManagedOAuthDatabase } from '../../../agor-cli/src/lib/managed-oauth-observation';

describe.skipIf(process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'managed database observation CLI',
  () => {
    let owned: OwnedPostgres;
    beforeAll(async () => {
      owned = await createOwnedPostgres();
    }, 120000);
    afterAll(async () => {
      await owned?.dispose();
    }, 30000);

    it('reports actual login/current roles and the same live schema digest without exposing tenant state', async () => {
      const [roles] =
        await owned.sql`SELECT session_user::text AS login, current_user::text AS current`;
      const before = await observeManagedOAuthDatabase(owned.db, 'cell', 'cell');
      expect(MCPManagedOAuthDatabaseObservationReportSchema.parse(before)).toEqual(before);
      expect(before).toEqual({
        version: 1,
        cell_id: 'cell',
        schema_digest: await readManagedOAuthSchemaDigest(owned.db),
        database_role: {
          session_user: roles.login,
          current_user: roles.current,
          same_session_role: true,
          superuser: false,
          bypass_rls: false,
          create_role: false,
          create_database: false,
          privileged_membership: false,
          owns_or_inherits: false,
        },
      });
      await seedManagedRefreshGrant(owned.db, 'synthetic-observation-test-master');
      expect(await observeManagedOAuthDatabase(owned.peer, 'cell', 'cell')).toEqual(before);
    });
    it('cannot escalate an active tenant scope or accept a caller-selected deployment', async () => {
      await expect(
        runWithTenantDatabaseScope(owned.db, 'foreign-tenant', (tx) =>
          observeManagedOAuthDatabase(tx, 'cell', 'cell')
        )
      ).rejects.toThrow('Cannot enter system database scope');
      await expect(observeManagedOAuthDatabase(owned.db, 'foreign-cell', 'cell')).rejects.toThrow(
        'configured cell'
      );
      await expect(observeManagedOAuthDatabase(owned.db, 'cell')).rejects.toThrow(
        'configured cell'
      );
    });
    it('rejects a privileged login hidden behind SET ROLE', async () => {
      await owned.withPrivilegedSessionRole(async (db) => {
        await expect(observeManagedOAuthDatabase(db, 'cell', 'cell')).rejects.toThrow();
      });
    });
    it('rejects ledger drift rather than reporting an attestation-supplied digest', async () => {
      await owned.withMigrationLedgerDrift('hash', async () => {
        await expect(observeManagedOAuthDatabase(owned.db, 'cell', 'cell')).rejects.toThrow(
          'differs from this binary'
        );
      });
    });
  }
);
