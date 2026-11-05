import {
  BoardObjectRepository,
  BoardRepository,
  CapabilityPolicyRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  sql,
  UserApiKeysRepository,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBoardEntities } from '../../../test/board-entity-fixture.js';
import { boardMetadataTestApp } from '../../../test/board-metadata-app.js';
import type { RegisterHooksContext } from '../../register-hooks.js';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'MCP reposition tenant isolation and RBAC',
  () => {
    let raw: Database;
    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(raw);
      const result = await executeRaw(
        raw,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60000);
    afterAll(async () => {
      if (raw) await (raw as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    it('allows the owner, denies a foreign tenant admin and a same-tenant non-editor, and never triggers', async () => {
      const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
      const seed = (tenant: string, role: 'member' | 'admin') =>
        runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          const fixture = await seedBoardEntities(scoped, role);
          await new BoardRepository(scoped).update(fixture.board.board_id, {
            objects: {
              'zone-review': {
                type: 'zone',
                x: 2000,
                y: 1000,
                width: 1000,
                height: 800,
                label: 'Review',
                trigger: { behavior: 'always_new', template: 'Must not execute' },
              },
            },
          });
          const policies = new CapabilityPolicyRepository(scoped);
          const policy = await policies.getBoardPolicies(fixture.board.board_id);
          await policies.replaceBoardPolicies(
            fixture.board.board_id,
            {
              ...policy,
              board_access: {
                ...policy.board_access,
                sharing_mode: 'shared',
                others: { preset: 'viewer', capabilities: ['board.view'], fs_access: 'none' },
              },
            },
            fixture.owner.user_id
          );
          const keys = new UserApiKeysRepository(scoped);
          const ownerKey = (await keys.create(fixture.owner.user_id, 'test owner')).rawKey;
          const otherKey = (await keys.create(fixture.other.user_id, 'test other')).rawKey;
          return { ...fixture, ownerKey, otherKey };
        });
      const tenantA = `placement-a-${generateId()}`;
      const tenantB = `placement-b-${generateId()}`;
      const owner = await seed(tenantA, 'member');
      const foreign = await seed(tenantB, 'admin');
      const server = await boardMetadataTestApp(
        db,
        {
          database: { dialect: 'postgresql' },
          multi_tenancy: {
            mode: 'required_from_auth',
            trusted_header: 'x-agor-tenant-id',
            filesystem_isolation_enabled: true,
          },
          execution: {},
        } as RegisterHooksContext['config'],
        false,
        true
      );
      // The fixture has no sessions.create or prompt route: accidentally firing
      // the always_new template fails the successful reposition assertions below.
      const call = async (key: string, tenant: string, objectId: string, facade: boolean) => {
        const args = { objectId, position: 'bottom-right' };
        const response = await fetch(`${server.url}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-API-Key': key,
            'X-Agor-Tenant-Id': tenant,
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: facade
              ? {
                  name: 'agor_execute_tool',
                  arguments: { tool_name: 'agor_boards_set_position', arguments: args },
                }
              : { name: 'agor_boards_set_position', arguments: args },
          }),
        });
        expect(response.status).toBe(200);
        const body = await response.text();
        const parsed = JSON.parse(
          body
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6) ?? body
        );
        expect(parsed.error).toBeUndefined();
        return parsed.result as { isError?: boolean; content: { text: string }[] };
      };
      const read = (objectId: string) =>
        runWithTenantDatabaseScope(db, tenantA, (scoped) =>
          new BoardObjectRepository(scoped).findByObjectId(objectId)
        );
      try {
        for (const [object, position] of [
          [owner.entities[1], { x: 420, y: 520 }],
          [owner.cardObject, { x: 540, y: 590 }],
        ] as const) {
          const before = await read(object.object_id);
          for (const facade of [false, true]) {
            expect((await call(foreign.ownerKey, tenantB, object.object_id, facade)).isError).toBe(
              true
            );
            expect((await call(owner.otherKey, tenantA, object.object_id, facade)).isError).toBe(
              true
            );
            expect(await read(object.object_id)).toEqual(before);
          }
          const accepted = await call(owner.ownerKey, tenantA, object.object_id, true);
          expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
          expect(await read(object.object_id)).toMatchObject({ zone_id: 'zone-review', position });
        }
      } finally {
        await server.close();
      }
    }, 30000);
  }
);
