/** Active-active provider-observation proof. Requires two PostgreSQL pools. */
import http from 'node:http';
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  generateId,
  initializeDatabase,
  MCPServerRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  runWithTenantDatabaseTransaction,
  SessionMCPServerRepository,
  SessionRepository,
  setMCPEgressGatewayMode,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { TaskStatus, type TenantID, type UserID, type UUID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueMCPEgressCapability } from './capability.js';
import { MCPEgressGateway, mcpEgressMaterialHash } from './gateway.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'MCP egress final admission (PostgreSQL HA)',
  () => {
    let rawA: ReturnType<typeof createDatabase>;
    let rawB: ReturnType<typeof createDatabase>;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    const servers: http.Server[] = [];

    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      rawB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawA);
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'MCP egress daemon A',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'MCP egress daemon B',
      });
    });

    afterAll(async () => {
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      );
      await Promise.all([
        (rawA as typeof rawA & { $client: { end(): Promise<void> } }).$client.end(),
        (rawB as typeof rawB & { $client: { end(): Promise<void> } }).$client.end(),
      ]);
    });

    async function provider(handler: http.RequestListener): Promise<string> {
      const server = http.createServer(handler);
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      return `http://localhost:${address.port}/mcp`;
    }

    async function seed(tenantId: TenantID, url: string) {
      return runWithTenantDatabaseScope(dbA, tenantId, async (scoped) => {
        const user = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
          name: 'HA gateway owner',
          role: 'member',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId() as UUID,
          slug: `ha-egress-${generateId()}`,
          name: 'HA egress',
          repo_type: 'remote',
          remote_url: 'https://example.test/repo.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: 'ha-egress',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000),
          path: `/tmp/${generateId()}`,
          created_by: user.user_id as UUID,
        });
        const session = await new SessionRepository(scoped).create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          agentic_tool: 'codex',
          created_by: user.user_id as UserID,
        });
        const task = await new TaskRepository(scoped).create({
          task_id: generateId(),
          session_id: session.session_id,
          created_by: user.user_id,
          full_prompt: 'HA admission race',
          status: TaskStatus.RUNNING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'test' },
          tool_use_count: 0,
        });
        const mcpServer = await new MCPServerRepository(scoped).create({
          name: `ha-egress-${generateId()}`,
          transport: 'http',
          url,
          scope: 'session',
          source: 'user',
          enabled: true,
          owner_user_id: user.user_id as UserID,
          auth: { type: 'bearer', token: 'ha-provider-secret' },
        });
        await new SessionMCPServerRepository(scoped).addServer(
          session.session_id,
          mcpServer.mcp_server_id
        );
        await setMCPEgressGatewayMode(scoped, 'enforced', user.user_id);
        return { user, session, task, mcpServer };
      });
    }

    it('observes daemon-B commit before daemon-A final check and sends zero provider requests', async () => {
      const tenantId = `mcp-egress-ha-${generateId()}` as TenantID;
      let providerRequests = 0;
      const url = await provider((_request, response) => {
        providerRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      });
      const seeded = await seed(tenantId, url);
      let releaseDns!: () => void;
      let dnsStarted!: () => void;
      const dnsGate = new Promise<void>((resolve) => (releaseDns = resolve));
      const dnsObserved = new Promise<void>((resolve) => (dnsStarted = resolve));
      const jwtSecret = 'postgres-ha-gateway-signing-key';
      const gateway = new MCPEgressGateway({
        db: dbA,
        app: { get: () => undefined, service: () => ({}) } as unknown as Application,
        jwtSecret,
        branchRbacEnabled: false,
        allowLocalhostHttp: true,
        resolveDns: async () => {
          dnsStarted();
          await dnsGate;
          return [{ address: '127.0.0.1', family: 4 }];
        },
      });
      const capability = issueMCPEgressCapability(
        {
          tid: tenantId,
          task_id: seeded.task.task_id,
          session_id: seeded.session.session_id,
          principal_user_id: seeded.user.user_id,
          credential_user_id: seeded.user.user_id,
          mcp_server_id: seeded.mcpServer.mcp_server_id,
          config_version: seeded.mcpServer.config_version ?? 1,
          material_hash: mcpEgressMaterialHash(seeded.mcpServer, {}, jwtSecret),
          rollout_mode: 'enforced',
          jti: generateId(),
        },
        jwtSecret
      );

      const pending = gateway.forward({
        serverId: seeded.mcpServer.mcp_server_id,
        headers: new Headers({ 'x-agor-mcp-capability': capability }),
        method: 'POST',
        body: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"initialize"}'),
      });
      await dnsObserved;
      await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new MCPServerRepository(scoped).update(seeded.mcpServer.mcp_server_id, {
          description: 'committed by daemon B',
          expected_config_version: seeded.mcpServer.config_version,
        })
      );
      releaseDns();

      await expect(pending).rejects.toMatchObject({ code: 'tool_permission_changed' });
      expect(providerRequests).toBe(0);

      const wrongTenantCapability = issueMCPEgressCapability(
        {
          tid: `other-${tenantId}`,
          task_id: seeded.task.task_id,
          session_id: seeded.session.session_id,
          principal_user_id: seeded.user.user_id,
          credential_user_id: seeded.user.user_id,
          mcp_server_id: seeded.mcpServer.mcp_server_id,
          config_version: seeded.mcpServer.config_version ?? 1,
          material_hash: mcpEgressMaterialHash(seeded.mcpServer, {}, jwtSecret),
          rollout_mode: 'enforced',
          jti: generateId(),
        },
        jwtSecret
      );
      await expect(
        gateway.forward({
          serverId: seeded.mcpServer.mcp_server_id,
          headers: new Headers({ 'x-agor-mcp-capability': wrongTenantCapability }),
          method: 'POST',
          body: new TextEncoder().encode('{"jsonrpc":"2.0","id":2,"method":"initialize"}'),
        })
      ).rejects.toMatchObject({ code: 'rollout_changed' });
      expect(providerRequests).toBe(0);
    });

    it('allows a provider-observed request admitted before daemon-B commits', async () => {
      const tenantId = `mcp-egress-ha-admitted-${generateId()}` as TenantID;
      let releaseProvider!: () => void;
      let providerStarted!: () => void;
      const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve));
      const providerObserved = new Promise<void>((resolve) => (providerStarted = resolve));
      let providerRequests = 0;
      const url = await provider(async (_request, response) => {
        providerRequests += 1;
        providerStarted();
        await providerGate;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{"admitted":true}}');
      });
      const seeded = await seed(tenantId, url);
      const jwtSecret = 'postgres-ha-admitted-key';
      const gateway = new MCPEgressGateway({
        db: dbA,
        app: { get: () => undefined, service: () => ({}) } as unknown as Application,
        jwtSecret,
        branchRbacEnabled: false,
        allowLocalhostHttp: true,
        resolveDns: async () => [{ address: '127.0.0.1', family: 4 }],
      });
      const capability = issueMCPEgressCapability(
        {
          tid: tenantId,
          task_id: seeded.task.task_id,
          session_id: seeded.session.session_id,
          principal_user_id: seeded.user.user_id,
          credential_user_id: seeded.user.user_id,
          mcp_server_id: seeded.mcpServer.mcp_server_id,
          config_version: seeded.mcpServer.config_version ?? 1,
          material_hash: mcpEgressMaterialHash(seeded.mcpServer, {}, jwtSecret),
          rollout_mode: 'enforced',
          jti: generateId(),
        },
        jwtSecret
      );
      const pending = gateway.forward({
        serverId: seeded.mcpServer.mcp_server_id,
        headers: new Headers({ 'x-agor-mcp-capability': capability }),
        method: 'POST',
        body: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"initialize"}'),
      });
      await providerObserved;
      await runWithTenantDatabaseScope(dbB, tenantId, (scoped) =>
        new MCPServerRepository(scoped).update(seeded.mcpServer.mcp_server_id, {
          description: 'commit after provider observation',
          expected_config_version: seeded.mcpServer.config_version,
        })
      );
      releaseProvider();
      await expect((await pending).response.json()).resolves.toMatchObject({
        result: { admitted: true },
      });
      expect(providerRequests).toBe(1);
    });

    it('keeps a concurrent config+detach commit out of one repeatable-read authority snapshot', async () => {
      const tenantId = `mcp-egress-ha-snapshot-${generateId()}` as TenantID;
      let providerRequests = 0;
      const url = await provider((_request, response) => {
        providerRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      });
      const seeded = await seed(tenantId, url);
      let checkpointCount = 0;
      let releaseSnapshot!: () => void;
      let finalSnapshotStarted!: () => void;
      const snapshotGate = new Promise<void>((resolve) => (releaseSnapshot = resolve));
      const snapshotObserved = new Promise<void>((resolve) => (finalSnapshotStarted = resolve));
      const jwtSecret = 'postgres-ha-snapshot-key';
      const gateway = new MCPEgressGateway({
        db: dbA,
        app: { get: () => undefined, service: () => ({}) } as unknown as Application,
        jwtSecret,
        branchRbacEnabled: false,
        allowLocalhostHttp: true,
        resolveDns: async () => [{ address: '127.0.0.1', family: 4 }],
        authoritySnapshotCheckpoint: async () => {
          checkpointCount += 1;
          if (checkpointCount === 2) {
            finalSnapshotStarted();
            await snapshotGate;
          }
        },
      });
      const capability = issueMCPEgressCapability(
        {
          tid: tenantId,
          task_id: seeded.task.task_id,
          session_id: seeded.session.session_id,
          principal_user_id: seeded.user.user_id,
          credential_user_id: seeded.user.user_id,
          mcp_server_id: seeded.mcpServer.mcp_server_id,
          config_version: seeded.mcpServer.config_version ?? 1,
          material_hash: mcpEgressMaterialHash(seeded.mcpServer, {}, jwtSecret),
          rollout_mode: 'enforced',
          jti: generateId(),
        },
        jwtSecret
      );
      const pending = gateway.forward({
        serverId: seeded.mcpServer.mcp_server_id,
        headers: new Headers({ 'x-agor-mcp-capability': capability }),
        method: 'POST',
        body: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"initialize"}'),
      });
      await snapshotObserved;
      await runWithTenantDatabaseTransaction(dbB, tenantId, async (scoped) => {
        await new MCPServerRepository(scoped).update(seeded.mcpServer.mcp_server_id, {
          description: 'committed mixed-read adversary',
          expected_config_version: seeded.mcpServer.config_version,
        });
        await new SessionMCPServerRepository(scoped).removeServer(
          seeded.session.session_id,
          seeded.mcpServer.mcp_server_id
        );
      });
      releaseSnapshot();
      await expect(pending).resolves.toBeDefined();
      expect(providerRequests).toBe(1);
      await expect(
        gateway.forward({
          serverId: seeded.mcpServer.mcp_server_id,
          headers: new Headers({ 'x-agor-mcp-capability': capability }),
          method: 'POST',
          body: new TextEncoder().encode('{"jsonrpc":"2.0","id":2,"method":"initialize"}'),
        })
      ).rejects.toMatchObject({ code: expect.stringMatching(/stale_capability|server_detached/) });
    });
  }
);
