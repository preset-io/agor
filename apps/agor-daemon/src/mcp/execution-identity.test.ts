import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  createTenantScopedDatabaseProxy,
  generateId,
  KnowledgeNamespaceRepository,
  runWithTenantContext,
  TaskRepository,
  UserApiKeysRepository,
} from '@agor/core/db';
import { TaskStatus } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { executionTestServer } from '../../test/mcp-execution-fixture.js';
import { seedQueue } from '../../test/task-queue-fixture.js';
import { initMcpTokens } from './tokens.js';

dbTest(
  'only an authenticated active executor can attest identity; personal/session credentials and payloads cannot',
  async ({ db }) => {
    const seed = await seedQueue(db, { bindLaunchAuthority: true });
    const server = await executionTestServer(createTenantScopedDatabaseProxy(db), seed);
    try {
      const result = await server.call(server.mcpToken);
      expect(result.status).toBe(200);
      expect(result.result?.isError).not.toBe(true);
      const identity = JSON.parse(result.result!.content[0].text);
      expect(identity).toMatchObject({
        schema_version: 1,
        authentication_kind: 'executor-task',
        task_id: seed.active.task_id,
        session_id: seed.session.session_id,
        branch_id: seed.branch.branch_id,
        user_id: seed.owner.user_id,
        tenant_id: 'default',
      });
      expect(Date.parse(identity.valid_until)).toBeGreaterThan(Date.parse(identity.observed_at));
      expect(
        Date.parse(identity.valid_until) - Date.parse(identity.observed_at)
      ).toBeLessThanOrEqual(30_000);
      const source = jwt.decode(server.executorToken) as { jti: string; exp: number };
      expect(identity.execution_id).toBe(source.jti);
      expect(Date.parse(identity.valid_until)).toBeLessThanOrEqual(source.exp * 1000);
      expect(identity.execution_id).toEqual(expect.any(String));
      const namespace = await new KnowledgeNamespaceRepository(db).create({
        slug: `claims-${generateId()}`,
        owner_user_id: seed.owner.user_id,
        visibility_default: 'private',
      });
      const claim = {
        namespace: namespace.slug,
        path: 'tasks/stable.md',
        content: 'private state',
        visibility: 'private',
        editPolicy: 'owner',
      };
      expect(
        (await server.call(server.ordinaryToken, 'agor_kb_claim', claim)).result?.isError
      ).toBe(true);
      const claimed = await server.call(server.mcpToken, 'agor_kb_claim', claim);
      expect(claimed.result?.isError, JSON.stringify(claimed.result)).not.toBe(true);
      expect(JSON.parse(claimed.result!.content[0].text)).toMatchObject({
        status: 'created',
        document: { visibility: 'private', edit_policy: 'owner' },
        writer: { execution_id: source.jti },
      });
      expect((await server.call(server.mcpToken, 'agor_kb_claim', claim)).result?.isError).toBe(
        true
      );
      expect(JSON.stringify(identity)).not.toMatch(/tokenFingerprint|accessToken|mcp_token/);
      expect((await server.call(server.ordinaryToken)).result?.isError).toBe(true);
      const personal = await new UserApiKeysRepository(db).create(seed.owner.user_id, 'synthetic');
      expect(
        (
          await server.call(
            personal.rawKey,
            undefined,
            {},
            { 'X-Agor-Session-Id': seed.session.session_id }
          )
        ).result?.isError
      ).toBe(true);
      expect(
        (
          await server.call(server.ordinaryToken, undefined, {
            execution_id: identity.execution_id,
            authenticated: true,
          })
        ).result?.isError
      ).toBe(true);
      expect(
        (
          await server.call(
            server.mcpToken,
            undefined,
            {},
            { 'X-Agor-Session-Id': seed.queued[0].task_id }
          )
        ).status
      ).toBe(403);
      const tokenParts = server.mcpToken.split('.');
      const tampered = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString());
      tampered.execution.taskId = seed.queued[0].task_id;
      tokenParts[1] = Buffer.from(JSON.stringify(tampered)).toString('base64url');
      expect((await server.call(tokenParts.join('.'))).status).toBe(401);
    } finally {
      await server.close();
    }
  }
);

dbTest(
  'held MCP credentials recheck executor revocation without stamping a heartbeat',
  async ({ db }) => {
    const seed = await seedQueue(db, { bindLaunchAuthority: true });
    const server = await executionTestServer(createTenantScopedDatabaseProxy(db), seed);
    try {
      const before = await new TaskRepository(db).findById(seed.active.task_id);
      expect((await server.call(server.mcpToken)).result?.isError).not.toBe(true);
      expect(await new TaskRepository(db).findById(seed.active.task_id)).toEqual(before);
      await runWithTenantContext('default', () =>
        server.taskTokens.revokeToken(server.executorToken)
      );
      expect((await server.call(server.mcpToken)).status).toBe(401);
      // A fresh module/empty standalone authority has no accepting fallback.
      initMcpTokens({
        db: createTenantScopedDatabaseProxy(db),
        multiTenancy: resolveMultiTenancyConfig({}),
      });
      expect((await server.call(server.mcpToken)).status).toBe(401);
    } finally {
      await server.close();
    }
  }
);

dbTest('a completed execution cannot continue attesting its old identity', async ({ db }) => {
  const seed = await seedQueue(db, { bindLaunchAuthority: true });
  const tasks = new TaskRepository(db);
  const server = await executionTestServer(createTenantScopedDatabaseProxy(db), seed);
  try {
    await tasks.update(seed.active.task_id, { status: TaskStatus.COMPLETED });
    expect((await server.call(server.mcpToken)).status).toBe(401);
  } finally {
    await server.close();
  }
});
