/** Test-only task gateway composition; no executor process or authority replacement. */
import {
  BranchRepository,
  generateId,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionMCPServerRepository,
  SessionRepository,
  TaskRepository,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '@agor/core/db';
import { type MCPServer, TaskStatus, type UserID, type UUID } from '@agor/core/types';
import { issueMCPEgressCapability } from '../../mcp-egress/capability';
import {
  MCPEgressGateway,
  mcpEgressMaterialHash,
  mcpOAuthGrantIdentity,
} from '../../mcp-egress/gateway';
import type { startManagedPairedRuntime } from './managed-paired-runtime';

type Runtime = Awaited<ReturnType<typeof startManagedPairedRuntime>>;

export async function createPairedTaskGateway(runtime: Runtime, server: MCPServer) {
  const secret = 'synthetic-paired-task-capability-only';
  const seed = await runWithTenantDatabaseScope(runtime.db, runtime.tenantId, async (db) => {
    const context = async (userId: UserID) => {
      const repo = await new RepoRepository(db).create({
        repo_id: generateId() as UUID,
        slug: `paired-gateway-${generateId()}`,
        name: 'Paired gateway',
        repo_type: 'remote',
        remote_url: 'https://repository.paired.test/repo.git',
        local_path: `/tmp/${generateId()}`,
        default_branch: 'main',
      });
      const branch = await new BranchRepository(db).create({
        branch_id: generateId(),
        repo_id: repo.repo_id,
        name: 'paired-gateway',
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000),
        path: `/tmp/${generateId()}`,
        created_by: userId as UUID,
      });
      const session = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'codex',
        created_by: userId,
      });
      const task = await new TaskRepository(db).create({
        task_id: generateId(),
        session_id: session.session_id,
        created_by: userId,
        full_prompt: 'Read synthetic paired provider data',
        status: TaskStatus.RUNNING,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
        tool_use_count: 0,
      });
      // The foreign caller cannot legitimately attach the owner's private row.
      if (userId === runtime.user.user_id)
        await new SessionMCPServerRepository(db).addServer(
          session.session_id,
          server.mcp_server_id
        );
      return { session, task };
    };
    const owner = await context(runtime.user.user_id as UserID);
    const foreign = await new UsersRepository(db).create({
      email: `${generateId()}@paired.test`,
      name: 'Foreign task caller',
      role: 'member',
    });
    const other = await context(foreign.user_id as UserID);
    const grant = await new UserMCPOAuthTokenRepository(db).getToken(
      runtime.user.user_id as UserID,
      server.mcp_server_id
    );
    const grantIdentity = mcpOAuthGrantIdentity(grant);
    if (!grantIdentity) throw new Error('Paired task gateway requires a real committed grant');
    return { owner, foreign, other, grantIdentity };
  });
  const gateway = new MCPEgressGateway({
    db: runtime.db,
    app: runtime.app,
    jwtSecret: secret,
    resolveManagedAuthorization: runtime.services.grantAccess.acquireAuthorization,
    assertManagedUse: runtime.services.grantAccess.assertManagedUse,
  });
  const claims = {
    tid: runtime.tenantId,
    task_id: seed.owner.task.task_id,
    session_id: seed.owner.session.session_id,
    principal_user_id: runtime.user.user_id,
    credential_user_id: runtime.user.user_id,
    mcp_server_id: server.mcp_server_id,
    config_version: server.config_version ?? 1,
    material_hash: mcpEgressMaterialHash(server, {}, secret),
    grant_identity: seed.grantIdentity,
    rollout_mode: 'enforced' as const,
  };
  const capability = issueMCPEgressCapability({ ...claims, jti: generateId() }, secret);
  const foreignCaller = issueMCPEgressCapability(
    {
      ...claims,
      principal_user_id: seed.foreign.user_id,
      credential_user_id: seed.foreign.user_id,
      jti: generateId(),
    },
    secret
  );
  const foreignTask = issueMCPEgressCapability(
    {
      ...claims,
      task_id: seed.other.task.task_id,
      session_id: seed.other.session.session_id,
      jti: generateId(),
    },
    secret
  );
  return {
    forward: async (method: 'tools/list' | 'tools/call', credential = capability) => {
      const result = await gateway.forward({
        serverId: server.mcp_server_id,
        headers: new Headers({
          'x-agor-mcp-capability': credential,
          'content-type': 'application/json',
        }),
        method: 'POST',
        body: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            ...(method === 'tools/call' ? { params: { name: 'fake_read', arguments: {} } } : {}),
          })
        ),
      });
      if (!result.response.ok) throw new Error('Paired provider rejected task hop');
      return result.response.json();
    },
    foreignCaller,
    foreignTask,
    retireTask: () =>
      runWithTenantDatabaseScope(runtime.db, runtime.tenantId, (db) =>
        new TaskRepository(db).update(seed.owner.task.task_id, { status: TaskStatus.COMPLETED })
      ),
  };
}
