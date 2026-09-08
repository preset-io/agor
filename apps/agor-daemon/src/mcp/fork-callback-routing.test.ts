/**
 * #2654: routing already passed on baseline; runtime identity assertions also
 * cover the approved model-context mitigation.
 * Real fork/spawn, token hooks, Claude query options, HTTP MCP, persistence and
 * terminal-task dispatch. SDK execution, launch/queue draining, model listing
 * and messages are stubbed; read services use repository-backed adapters rather
 * than the global Feathers hook stack. This is not full SDK/RBAC integration.
 */
import { resolveMultiTenancyConfig } from '@agor/core/config';
import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { Session } from '@agor/core/types';
import express from 'express';
import { afterEach, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { setupQuery } from '../../../../packages/executor/src/sdk-handlers/claude/query-builder';
import { SessionsService } from '../services/sessions';
import { TasksService } from '../services/tasks';
import { createSessionMcpTokenAfterHooks } from '../utils/session-mcp-token-hook';
import { setupMCPRoutes } from './server';
import { initMcpTokens, shutdownMcpTokens } from './tokens';

const sdk = vi.hoisted(() => ({ query: vi.fn(() => ({})) }));
vi.mock('@agor/core/agentic-integrations', async (original) => ({
  ...(await original<typeof import('@agor/core/agentic-integrations')>()),
  loadManagedAgenticToolSdk: vi.fn(async () => sdk),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  shutdownMcpTokens();
  vi.restoreAllMocks();
});

dbTest(
  'fork runtime -> authenticated MCP -> persisted callback -> completion queue',
  async ({ db }) => {
    const users = new UsersRepository(db);
    const user = await users.create({ email: `${generateId()}@example.com`, name: 'Caller' });
    const repos = new RepoRepository(db);
    const repo = await repos.create({
      slug: `callback-${generateId()}`,
      name: 'Callback test',
      repo_type: 'remote',
      remote_url: 'https://example.com/test.git',
      local_path: process.cwd(),
      default_branch: 'main',
    });
    const branches = new BranchRepository(db);
    const makeBranch = (name: string, uniqueId: number) =>
      branches.create({
        repo_id: repo.repo_id,
        name,
        ref: 'main',
        branch_unique_id: uniqueId,
        path: process.cwd(),
        base_ref: 'main',
        new_branch: false,
        created_by: user.user_id,
      });
    const branch = await makeBranch('local', 1);
    const remote = await makeBranch('remote', 2);
    const app = feathers();
    app.set('authentication', { secret: 'fork-callback-test-secret' });
    app.set('config', { execution: { unix_user_mode: 'simple' } });
    app.use('users', { get: (id: string) => users.findById(id) });
    app.use('branches', { get: (id: string) => branches.findById(id) });
    app.use('claude-models', { find: async () => [] });
    app.use('messages', { find: async () => [] });
    const sessions = new SessionsService(db, app as never, () => true);
    app.use('sessions', sessions);
    const queue = vi.spyOn(sessions, 'triggerQueueProcessing').mockResolvedValue(undefined);
    const hooks = createSessionMcpTokenAfterHooks({ app: app as never, config: {} });
    app.service('sessions').hooks({ after: { get: [hooks.get], create: [hooks.create] } });
    initMcpTokens({ db, multiTenancy: resolveMultiTenancyConfig({}) });
    const tasks = new TaskRepository(db);
    const taskService = new TasksService(db, app as never);
    app.use('tasks', taskService);
    app.use('/sessions/:id/prompt', {
      create: (data: { prompt: string }, params: { route: { id: Session['session_id'] } }) =>
        tasks.createPending({
          session_id: params.route.id,
          full_prompt: data.prompt,
          created_by: user.user_id,
          status: 'queued',
        }),
    });
    const params = { user };
    const original = await sessions.create({
      branch_id: branch.branch_id,
      agentic_tool: 'claude-code',
      created_by: user.user_id,
      status: 'idle',
      model_config: { model: 'claude-sonnet-4-6' },
    });
    await new SessionRepository(db).update(original.session_id, { sdk_session_id: 'sdk-original' });
    const fork = await sessions.fork(original.session_id, { prompt: 'Fork B' }, params);
    expect(fork.genealogy.forked_from_session_id).toBe(original.session_id);
    expect(fork.sdk_session_id).toBeUndefined();

    async function runtimeHeaders(session: Session, expectedResume?: string) {
      const deps = {
        sessionsRepo: { findById: (id: string) => app.service('sessions').get(id, params) },
        branchesRepo: branches,
      } as unknown as Parameters<typeof setupQuery>[2];
      const result = await setupQuery(
        session.session_id,
        `Inherited example: callbackSessionId=${original.session_id}. Delegate work.`,
        deps
      );
      result.query.releaseInput();
      const options = (
        sdk.query.mock.calls.at(-1) as unknown as [
          {
            options: {
              systemPrompt: { append: string };
              resume?: string;
              forkSession?: boolean;
              mcpServers: { agor: { headers: Record<string, string> } };
            };
          },
        ]
      )[0].options;
      expect(options.systemPrompt.append).toContain(
        `Current Agor session ID: ${session.session_id}`
      );
      expect(options.systemPrompt.append).toContain(
        'enableCallback:true and omit callbackSessionId'
      );
      if (expectedResume)
        expect(options).toMatchObject({ resume: expectedResume, forkSession: true });
      return options.mcpServers.agor.headers;
    }

    const web = express();
    web.use(express.json());
    web.set('authentication', app.get('authentication'));
    Object.assign(web, { service: app.service.bind(app) });
    setupMCPRoutes(web as never, db, true);
    const server = web.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const address = server.address() as { port: number };
      const daemonUrl = `http://127.0.0.1:${address.port}`;
      // setupQuery reads this at call time, as it would in a spawned executor.
      vi.stubEnv('DAEMON_URL', daemonUrl);
      const call = async (
        headers: Record<string, string>,
        tool: string,
        args: Record<string, unknown>
      ) => {
        const response = await fetch(`${daemonUrl}/mcp`, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'X-Agor-Session-Id': original.session_id,
            'Mcp-Session-Id': 'copied-original-transport',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'agor_execute_tool', arguments: { tool_name: tool, arguments: args } },
          }),
        });
        const text = await response.text();
        expect(response.status, text).toBe(200);
        const payload = JSON.parse(
          text
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6) ?? text
        );
        expect(payload.result?.isError, text).not.toBe(true);
        return JSON.parse(payload.result.content[0].text);
      };
      const originalToken = (await app.service('sessions').get(original.session_id, params))
        .mcp_token;
      // Send A first, then reuse a stale transport/header hint with B's actual
      // runtime credentials. No request-local handler may keep A's identity.
      await call({ Authorization: `Bearer ${originalToken}` }, 'agor_users_get_current', {});
      const forkHeaders = await runtimeHeaders(fork, 'sdk-original');
      const coordinatorResult = await call(forkHeaders, 'agor_sessions_spawn', {
        prompt: 'Coordinator',
      });
      const coordinator = await app.service('sessions').get(coordinatorResult.session.session_id);
      const coordinatorHeaders = await runtimeHeaders(coordinator);
      for (const scenario of [
        {
          name: 'fork: same-branch create defaults callback to caller',
          tool: 'agor_sessions_create',
          args: { enableCallback: true },
        },
        {
          name: 'fork: spawn defaults callback to caller',
          tool: 'agor_sessions_spawn',
          args: {},
        },
        {
          name: 'fork: cross-branch create defaults callback to caller',
          tool: 'agor_sessions_create',
          args: { enableCallback: true, branchId: remote.branch_id },
        },
        {
          name: 'fork: cross-branch create preserves explicit original target',
          tool: 'agor_sessions_create',
          // Matches the verified incident call shape. The server cannot
          // distinguish a stale explicit A from an intentional override.
          args: {
            enableCallback: true,
            callbackSessionId: original.session_id,
            callbackMode: 'once',
            branchId: remote.branch_id,
          },
        },
        {
          name: 'fork: same-branch create disables callback',
          tool: 'agor_sessions_create',
          args: { enableCallback: false },
        },
        {
          name: 'fork: spawn disables callback',
          tool: 'agor_sessions_spawn',
          args: { enableCallback: false },
        },
        {
          name: 'fork: cross-branch create disables callback',
          tool: 'agor_sessions_create',
          args: { enableCallback: false, branchId: remote.branch_id },
        },
        {
          name: 'fork: same-branch create opts out of genealogy',
          tool: 'agor_sessions_create',
          args: { enableCallback: true, parentSessionId: null },
        },
        {
          name: 'coordinator: cross-branch create defaults callback to caller',
          tool: 'agor_sessions_create',
          nested: true,
          args: { enableCallback: true, branchId: remote.branch_id },
        },
        {
          name: 'coordinator: cross-branch create preserves explicit original target',
          tool: 'agor_sessions_create',
          nested: true,
          args: {
            enableCallback: true,
            branchId: remote.branch_id,
            callbackSessionId: original.session_id,
          },
        },
        {
          name: 'coordinator: spawn defaults callback to caller',
          tool: 'agor_sessions_spawn',
          nested: true,
          args: {},
        },
      ]) {
        try {
          const caller = scenario.nested ? coordinator : fork;
          const expectedBranchId = scenario.args.branchId ?? branch.branch_id;
          const result = await call(
            scenario.nested ? coordinatorHeaders : forkHeaders,
            scenario.tool,
            {
              ...(scenario.tool === 'agor_sessions_create'
                ? { branchId: branch.branch_id }
                : { prompt: 'Child C' }),
              agenticTool: 'claude-code',
              ...scenario.args,
            }
          );
          const child = await app
            .service('sessions')
            .get(result.session?.session_id ?? result.session_id);
          const enabled = scenario.args.enableCallback !== false;
          const target = scenario.args.callbackSessionId ?? caller.session_id;
          expect(child.branch_id, 'child must use the requested scenario branch').toBe(
            expectedBranchId
          );
          if (enabled) expect(child.callback_config.callback_session_id).toBe(target);
          if (expectedBranchId !== caller.branch_id) {
            expect(child.genealogy.parent_session_id).toBeNull();
            expect(result.remoteRelationship).toMatchObject({
              source_session_id: caller.session_id,
              callback_session_id: target,
              callback_enabled: enabled,
            });
          } else if (scenario.args.parentSessionId !== null) {
            expect(child.genealogy.parent_session_id).toBe(caller.session_id);
          } else {
            expect(child.genealogy.parent_session_id).toBeNull();
          }
          queue.mockClear();
          const task = await tasks.createPending({
            session_id: child.session_id,
            full_prompt: 'Child C',
            created_by: user.user_id,
            status: 'created',
          });
          await taskService.patch(task.task_id, { status: 'completed' });
          const callbacks = (await tasks.findAll()).filter(
            (t) => t.metadata?.child_task_id === task.task_id
          );
          expect(callbacks).toHaveLength(enabled ? 1 : 0);
          if (enabled) {
            expect(callbacks[0]).toMatchObject({ session_id: target, status: 'queued' });
            expect(queue).toHaveBeenCalledWith(target, {});
            if (target !== original.session_id) {
              expect(queue.mock.calls.map(([id]) => id)).not.toContain(original.session_id);
            }
          }
        } catch (cause) {
          throw new Error(`Callback routing scenario failed: ${scenario.name}`, { cause });
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      );
    }
  },
  30000
);
