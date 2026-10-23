import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  acquireTenantWriteGate,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  eq,
  executeRaw,
  generateId,
  initializeDatabase,
  isPostgresDatabase,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  kbDocumentVersions,
  releaseTenantWriteGate,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  select,
  sql,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Conflict, NotFound } from '@agor/core/feathers';
import type { TenantID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executionTestServer } from '../../test/mcp-execution-fixture.js';
import { seedQueue } from '../../test/task-queue-fixture.js';
import { KnowledgeDocumentsService } from '../services/knowledge-documents.js';
import { SessionTokenService } from '../services/session-token-service.js';
import { initMcpTokens, verifySessionToken } from './tokens.js';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'execution identity and claims PostgreSQL/RLS',
  () => {
    let rawA: Database;
    let rawB: Database;
    let dbA: TenantScopeAwareDatabase;
    let dbB: TenantScopeAwareDatabase;
    beforeAll(async () => {
      rawA = createDatabase({ dialect: 'postgresql', url: url! });
      rawB = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(rawA);
      if (!isPostgresDatabase(rawA)) throw new Error('Requires PostgreSQL');
      const result = await executeRaw(
        rawA,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      dbA = createTenantScopedDatabaseProxy(rawA, {
        requireScope: true,
        label: 'execution-daemon-a',
      });
      dbB = createTenantScopedDatabaseProxy(rawB, {
        requireScope: true,
        label: 'execution-daemon-b',
      });
    }, 60_000);
    afterAll(async () => {
      for (const raw of [rawA, rawB]) {
        if (raw) await (raw as Database & { $client: { end: () => Promise<void> } }).$client.end();
      }
    });

    it('revalidates held credentials across daemon state replacement, tenant boundaries and revocation', async () => {
      const tenant = `execution-${generateId()}`;
      const foreignTenant = `foreign-${generateId()}`;
      const seed = await runWithTenantContext(tenant, () =>
        runWithTenantDatabaseScope(dbA, tenant, (scoped) =>
          seedQueue(scoped, { bindLaunchAuthority: true })
        )
      );
      const server = await executionTestServer(dbA, seed, tenant, true);
      try {
        expect((await server.call(server.mcpToken)).result?.isError).not.toBe(true);
        const namespace = await runWithTenantContext(tenant, () =>
          runWithTenantDatabaseScope(dbA, tenant, (scoped) =>
            new KnowledgeNamespaceRepository(scoped).create({
              slug: `native-claims-${generateId()}`,
              owner_user_id: seed.owner.user_id,
              visibility_default: 'private',
            })
          )
        );
        const claim = {
          namespace: namespace.slug,
          path: 'tasks/current.md',
          content: 'private state',
          visibility: 'private',
          editPolicy: 'owner',
        };
        expect(
          (await server.call(server.mcpToken, 'agor_kb_claim', claim)).result?.isError
        ).not.toBe(true);
        const gate = await acquireTenantWriteGate(rawA, tenant);
        try {
          expect(
            (
              await server.call(server.mcpToken, 'agor_kb_claim', {
                ...claim,
                path: 'tasks/during-freeze.md',
              })
            ).result?.isError
          ).toBe(true);
          expect(
            await runWithTenantContext(tenant, () =>
              runWithTenantDatabaseScope(dbA, tenant, (scoped) =>
                new KnowledgeDocumentRepository(scoped).findByNamespaceAndPath(
                  namespace.namespace_id,
                  'tasks/during-freeze.md'
                )
              )
            )
          ).toBeNull();
        } finally {
          await releaseTenantWriteGate(rawA, tenant, { generation: gate.generation });
        }
        const peerAuthority = new SessionTokenService(
          { expiration_ms: 300_000, max_uses: -1 },
          { db: dbB, startCleanupTimer: false }
        );
        peerAuthority.setJwtSecret(server.app.get('authentication').secret as string);
        initMcpTokens({
          db: dbB,
          multiTenancy: resolveMultiTenancyConfig(server.app.get('config')),
          taskAuthorityStore: peerAuthority,
        });
        // No per-daemon token map, issuance cache or inherited authorization is needed.
        expect((await server.call(server.mcpToken)).result?.isError).not.toBe(true);
        const context = verifySessionToken(server.app, server.mcpToken)!;
        const payload = jwt.decode(server.mcpToken) as Record<string, unknown>;
        const foreign = jwt.sign(
          { ...payload, tid: foreignTenant as TenantID },
          server.app.get('authentication').secret as string,
          { algorithm: 'HS256' }
        );
        expect((await server.call(foreign)).status).toBe(401);
        expect(context.execution?.taskId).toBe(seed.active.task_id);
        await runWithTenantContext(tenant, () => peerAuthority.revokeToken(server.executorToken));
        expect((await server.call(server.mcpToken)).status).toBe(401);
        expect(
          (
            await server.call(server.mcpToken, 'agor_kb_claim', {
              ...claim,
              path: 'tasks/after-revocation.md',
            })
          ).status
        ).toBe(401);
        expect(
          await runWithTenantContext(tenant, () =>
            runWithTenantDatabaseScope(dbA, tenant, (scoped) =>
              new KnowledgeDocumentRepository(scoped).findByNamespaceAndPath(
                namespace.namespace_id,
                'tasks/after-revocation.md'
              )
            )
          )
        ).toBeNull();
      } finally {
        await server.close();
      }
    });

    it('atomically reserves one path across independent connections and isolates equal paths in other tenants', async () => {
      const tenantA = `claim-a-${generateId()}`;
      const tenantB = `claim-b-${generateId()}`;
      const seed = (tenant: string) =>
        runWithTenantContext(tenant, () =>
          runWithTenantDatabaseScope(dbA, tenant, async (scoped) => {
            const queued = await seedQueue(scoped);
            const namespace = await new KnowledgeNamespaceRepository(scoped).create({
              slug: 'same-claim-space',
              visibility_default: 'private',
              owner_user_id: queued.owner.user_id,
              others_can: 'none',
            });
            return { owner: queued.owner, namespace };
          })
        );
      const a = await seed(tenantA);
      const b = await seed(tenantB);
      const serviceA = new KnowledgeDocumentsService(dbA);
      const serviceB = new KnowledgeDocumentsService(dbB);
      const input = {
        namespace_slug: a.namespace.slug,
        path: 'tasks/stable.md',
        content_text: 'private claim',
        visibility: 'private' as const,
        edit_policy: 'owner' as const,
      };
      const race = await Promise.allSettled([
        runWithTenantContext(tenantA, () =>
          runWithTenantDatabaseScope(dbA, tenantA, () =>
            serviceA.claimDocument(input, { user: a.owner })
          )
        ),
        runWithTenantContext(tenantA, () =>
          runWithTenantDatabaseScope(dbB, tenantA, () =>
            serviceB.claimDocument(input, { user: a.owner })
          )
        ),
      ]);
      const accepted = race.filter((result) => result.status === 'fulfilled');
      expect(accepted).toHaveLength(1);
      const rejected = race.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(Conflict);
      const winner = accepted[0].value;
      await runWithTenantContext(tenantA, () =>
        runWithTenantDatabaseScope(dbB, tenantA, async (scoped) => {
          expect(
            (await new KnowledgeDocumentsService(dbB).get(winner.document_id, { user: a.owner }))
              .document_id
          ).toBe(winner.document_id);
          const versions = await select(scoped)
            .from(kbDocumentVersions)
            .where(eq(kbDocumentVersions.document_id, winner.document_id))
            .all();
          expect(versions).toHaveLength(1);
          expect(versions[0].version_number).toBe(1);
        })
      );
      await runWithTenantContext(tenantB, () =>
        runWithTenantDatabaseScope(dbB, tenantB, async () => {
          await expect(serviceB.get(winner.document_id, { user: b.owner })).rejects.toBeInstanceOf(
            NotFound
          );
          const ownClaim = await serviceB.claimDocument(input, { user: b.owner });
          expect(ownClaim.document_id).not.toBe(winner.document_id);
          expect(ownClaim.namespace_id).toBe(b.namespace.namespace_id);
        })
      );
    });
  }
);
