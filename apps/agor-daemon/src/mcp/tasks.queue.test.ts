import { resolveMultiTenancyConfig } from '@agor/core/config';
import { createTenantScopedDatabaseProxy, shortId, TaskRepository } from '@agor/core/db';
import { expect, vi } from 'vitest';
import { dbTest, setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers';
import { queueTestServer, seedQueue } from '../../test/task-queue-fixture.js';
import { generateSessionToken, initMcpTokens, shutdownMcpTokens } from './tokens.js';

// Exercise real MCP discovery and execution with delegated Session credentials,
// not a fabricated ctx or direct repository wrapper.
dbTest(
  'queued-task tools are discoverable, typed, and preserve delegated actor authority',
  async ({ db }) => {
    const guardedDb = createTenantScopedDatabaseProxy(db);
    const seed = await seedQueue(db);
    await setTestBranchUserRole(db, seed.branch.branch_id, seed.stranger.user_id, 'collaborator');
    const server = await queueTestServer(guardedDb);
    initMcpTokens({
      db: guardedDb,
      multiTenancy: resolveMultiTenancyConfig(server.app.get('config')),
    });
    const token = await generateSessionToken(
      server.app,
      seed.session.session_id,
      seed.owner.user_id
    );
    const restrictedToken = await generateSessionToken(
      server.app,
      seed.session.session_id,
      seed.stranger.user_id
    );
    const call = async (name: string, args: Record<string, unknown>, credential = token) => {
      const response = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const body = await response.text();
      const parsed = JSON.parse(
        body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6) ?? body
      );
      return { status: response.status, ...parsed };
    };
    try {
      const discovered = await call('agor_search_tools', { query: 'queued', max_results: 50 });
      expect(JSON.stringify(discovered)).toContain('agor_tasks_cancel_queued');
      expect(JSON.stringify(discovered)).toContain('agor_tasks_reorder_queued');
      const details = await call('agor_get_tool_details', {
        tool_name: 'agor_tasks_reorder_queued',
      });
      expect(JSON.stringify(details)).toContain('expectedTaskIds');
      const workflowTools = [
        'agor_sessions_prompt',
        'agor_tasks_cancel_queued',
        'agor_tasks_reorder_queued',
        'agor_sessions_stop',
      ];
      for (const name of workflowTools) {
        const metadata = await call('agor_get_tool_details', { tool_name: name });
        const description: string = JSON.parse(metadata.result.content[0].text).tool.description;
        for (const related of workflowTools.filter((tool) => tool !== name)) {
          expect(description).toContain(related);
        }
        expect(description).toContain('mode=continue');
        expect(description).toContain('expectedTaskIds');
        expect(description).toContain('original active task ID');
        expect(description).toContain('expectedTaskId');
        expect(description).toContain('condition_changed');
        expect(description).toContain('never fall back to an unconditional stop');
        expect(description).toMatch(/ONLY THEN.*stop/);
        expect(description).toMatch(/stop preserves\/drains/i);
        expect(description).toContain('stopping first risks dispatching stale work');
        expect(description).toContain('separate calls are not atomic');
        expect(description).toContain('re-read');
        if (name !== 'agor_tasks_cancel_queued') {
          expect(description).toContain('next turn after verified termination');
          expect(description).toContain(
            'not in-place injection or guaranteed instantaneous delivery'
          );
          expect(description).toContain('Accepted/pending stop is not confirmed termination');
          expect(description).toMatch(/edits.*preserved|preserves existing running-task edits/);
          expect(description).toMatch(/not rolled back|does not roll back/);
        }
      }
      const list = await call('agor_tasks_list', {
        sessionId: seed.session.session_id,
        status: 'queued',
      });
      expect(list.result.isError).not.toBe(true);
      const page = JSON.parse(list.result.content[0].text);
      expect(page.data.map((t: { task_id: string }) => t.task_id)).toEqual(
        seed.queued.map((t) => t.task_id)
      );
      const ids = seed.queued.map((t) => t.task_id);
      for (const name of ['agor_tasks_cancel_queued', 'agor_tasks_reorder_queued']) {
        const args = { sessionId: seed.session.session_id, taskIds: ids, expectedTaskIds: ids };
        const denied = await call(name, args, restrictedToken);
        expect(denied.result?.isError || denied.error).toBeTruthy();
        const invalid = await call(name, { ...args, taskIds: [ids[0], ids[0]] });
        expect(invalid.result?.isError || invalid.error).toBeTruthy();
      }
      const reordered = await call('agor_execute_tool', {
        tool_name: 'agor_tasks_reorder_queued',
        arguments: {
          sessionId: seed.session.session_id,
          expectedTaskIds: ids,
          taskIds: [...ids].reverse(),
        },
      });
      expect(reordered.result.isError).not.toBe(true);
      expect(
        JSON.parse(reordered.result.content[0].text).queue.map(
          (t: { task_id: string }) => t.task_id
        )
      ).toEqual([...ids].reverse());
      const cancelled = await call('agor_tasks_cancel_queued', {
        sessionId: seed.session.session_id,
        taskIds: [ids[1]],
      });
      expect(cancelled.result.isError).not.toBe(true);
      expect(cancelled.result.structuredContent.cancelled_task_ids).toEqual([ids[1]]);
      expect(
        cancelled.result.structuredContent.queue.map((t: { task_id: string }) => t.task_id)
      ).toEqual([ids[2], ids[0]]);
      const stale = await call('agor_tasks_reorder_queued', {
        sessionId: seed.session.session_id,
        expectedTaskIds: ids,
        taskIds: ids,
      });
      expect(stale.result.isError).toBe(true);
      expect(JSON.stringify(stale)).toContain('Reread');
      expect(await new TaskRepository(db).findById(seed.active.task_id)).toEqual(seed.active);

      // Real MCP schema and service-layer ID resolution. The route is a spy:
      // backend generation races are covered separately by session-stop.queue.test.
      const stop = vi.fn().mockResolvedValue({ success: false, outcome: 'condition_changed' });
      server.app.use('/sessions/:id/stop', { create: stop });
      const stopDetails = await call('agor_get_tool_details', { tool_name: 'agor_sessions_stop' });
      const schema = JSON.parse(stopDetails.result.content[0].text).tool.inputSchema;
      expect(schema.properties.expectedTaskId.type).toBe('string');
      expect(schema.required).not.toContain('expectedTaskId');
      const guarded = await call('agor_sessions_stop', {
        sessionId: seed.session.session_id,
        expectedTaskId: shortId(seed.active.task_id),
      });
      expect(JSON.parse(guarded.result.content[0].text).outcome).toBe('condition_changed');
      expect(stop).toHaveBeenCalledExactlyOnceWith(
        { expected_task_id: seed.active.task_id },
        expect.objectContaining({
          provider: 'mcp',
          tenant: { source: 'explicit', tenant_id: 'default' },
          user: expect.objectContaining({ user_id: seed.owner.user_id }),
          route: { id: seed.session.session_id },
        })
      );
      const foreign = await seedQueue(db);
      const deniedStop = await call('agor_sessions_stop', {
        sessionId: seed.session.session_id,
        expectedTaskId: shortId(foreign.active.task_id),
      });
      expect(deniedStop.result?.isError || deniedStop.error).toBeTruthy();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      shutdownMcpTokens();
      await server.close();
    }
  }
);
