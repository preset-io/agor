import type { TenantScopeAwareDatabase, TenantScopedDatabase } from '@agor/core/db';
import { createDatabaseAsync, MCPServerRepository, runMigrations } from '@agor/core/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMCPServersService,
  type MCPServerParams,
  runWithMCPServerMutationDatabase,
} from './mcp-servers.js';

async function databaseWithServer(label: string) {
  const db = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(db);
  const server = await new MCPServerRepository(db).create({
    name: 'binding-test',
    display_name: label,
    transport: 'http',
    url: 'https://mcp.example.test/mcp',
    auth: { type: 'none' },
    scope: 'global',
  });
  return { db, server };
}

describe('MCP mutation transaction binding', () => {
  const databases: Array<Awaited<ReturnType<typeof createDatabaseAsync>>> = [];
  afterEach(() => {
    while (databases.length) {
      databases.pop()?.$client?.close();
    }
  });

  it('preserves Feathers count-only pagination for $limit: 0', async () => {
    const base = await databaseWithServer('base');
    databases.push(base.db);
    const service = createMCPServersService(base.db as TenantScopeAwareDatabase);

    await expect(service.find({ query: { $limit: 0 } } as MCPServerParams)).resolves.toEqual({
      total: 1,
      limit: 0,
      skip: 0,
      data: [],
    });
  });

  it('keeps overlapping requests isolated even when they reuse one params object', async () => {
    const base = await databaseWithServer('base');
    const first = await databaseWithServer('first');
    const second = await databaseWithServer('second');
    databases.push(base.db, first.db, second.db);
    const service = createMCPServersService(base.db as TenantScopeAwareDatabase);
    const params = {} as MCPServerParams;

    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => (releaseFirst = resolve));
    const firstRequest = runWithMCPServerMutationDatabase(
      first.db as unknown as TenantScopedDatabase,
      async () => {
        await held;
        await service.patch(first.server.mcp_server_id, { display_name: 'first-updated' }, params);
      }
    );
    await runWithMCPServerMutationDatabase(second.db as unknown as TenantScopedDatabase, () =>
      service.patch(second.server.mcp_server_id, { display_name: 'second-updated' }, params)
    );
    releaseFirst();
    await firstRequest;
    expect(
      (await new MCPServerRepository(first.db).findById(first.server.mcp_server_id))?.display_name
    ).toBe('first-updated');
    expect(
      (await new MCPServerRepository(second.db).findById(second.server.mcp_server_id))?.display_name
    ).toBe('second-updated');
  });

  it('restores the exact outer repository after a nested binding completes', async () => {
    const base = await databaseWithServer('base');
    const first = await databaseWithServer('first');
    const second = await databaseWithServer('second');
    databases.push(base.db, first.db, second.db);
    const service = createMCPServersService(base.db as TenantScopeAwareDatabase);
    const params = {} as MCPServerParams;
    await runWithMCPServerMutationDatabase(
      first.db as unknown as TenantScopedDatabase,
      async () => {
        await runWithMCPServerMutationDatabase(second.db as unknown as TenantScopedDatabase, () =>
          service.patch(second.server.mcp_server_id, { display_name: 'second-updated' }, params)
        );
        await service.patch(first.server.mcp_server_id, { display_name: 'first-updated' }, params);
      }
    );
    expect(
      (await new MCPServerRepository(first.db).findById(first.server.mcp_server_id))?.display_name
    ).toBe('first-updated');
    expect(
      (await new MCPServerRepository(second.db).findById(second.server.mcp_server_id))?.display_name
    ).toBe('second-updated');
  });
});
