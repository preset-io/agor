/**
 * Regression tests for hooks registered in register-hooks.ts.
 *
 * Covers the sessions.patch permission branching introduced to fix the bug
 * where a user with `session`-tier permission on a branch could not prompt
 * their own session because the /sessions/:id/prompt route issues an internal
 * `{ tasks: [...] }` patch that was being gated behind `all`-tier.
 *
 * The branching logic in register-hooks.ts looks like:
 *
 *   if (isPromptFlowPatchOnly(context.data)) {
 *     → ensureCanPromptInSession (session-tier for own, prompt-tier otherwise)
 *   } else {
 *     → ensureBranchPermission('all')   // metadata writes
 *   }
 *
 * The two downstream hooks are covered elsewhere (see
 * branch-authorization.test.ts), so here we only verify the classifier.
 */

import { TaskStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  enrichSessionFindResultWithRemoteRelationships,
  getTrustedSessionTenantId,
  isPromptFlowPatchOnly,
  PROMPT_FLOW_PATCH_FIELDS,
  protectExternalTaskCreate,
  protectServerManagedTaskWrites,
  shouldDrainQueueAfterSessionPostTurnPatch,
  shouldRunSessionPostTurnHooks,
  shouldValidateRepoEnvironmentPayload,
  TENANT_IDENTITY_ONLY_SERVICE_PATHS,
  TENANT_OWNED_SERVICE_PATHS,
} from './register-hooks';
import { canReceiveMcpTokenForSession } from './utils/mcp-token-authorization';

const makeSession = (sessionId: string): import('@agor/core/types').Session =>
  ({
    session_id: sessionId,
    branch_id: 'branch-1',
    status: 'idle',
    agentic_tool: 'codex',
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: '2026-01-01T00:00:00.000Z',
    tasks: [],
    genealogy: { children: [] },
    contextFiles: [],
    git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
    scheduled_from_branch: false,
    ready_for_prompt: false,
    archived: false,
  }) as import('@agor/core/types').Session;

describe('protectExternalTaskCreate', () => {
  const context = (data: unknown, provider: string | null = 'rest') =>
    ({ data, params: { provider } }) as import('@agor/core/types').HookContext;

  it('preserves the documented dormant create/run contract', () => {
    const hook = context({ session_id: 'session-1', full_prompt: 'hello' });
    expect(protectExternalTaskCreate(hook)).toBe(hook);
    expect(hook.data).toEqual({
      session_id: 'session-1',
      full_prompt: 'hello',
      status: TaskStatus.CREATED,
    });
  });

  it.each(['running', 'queued', 'completed'])('rejects externally forged status %s', (status) => {
    expect(() =>
      protectExternalTaskCreate(context({ session_id: 'session-1', full_prompt: 'hello', status }))
    ).toThrow('must use status created');
  });

  it('rejects lifecycle and identity fields outside the create contract', () => {
    expect(() =>
      protectExternalTaskCreate(
        context({ session_id: 'session-1', full_prompt: 'hello', created_by: 'forged' })
      )
    ).toThrow('not client-managed');
  });

  it('leaves trusted internal task creation unchanged', () => {
    const hook = context({ status: TaskStatus.RUNNING }, null);
    expect(protectExternalTaskCreate(hook)).toBe(hook);
    expect(hook.data).toEqual({ status: TaskStatus.RUNNING });
  });
});

describe('protectServerManagedTaskWrites', () => {
  const executorPayload = {
    type: 'executor-session',
    purpose: 'executor-task',
    session_id: 'session-1',
    task_id: 'task-1',
    branch_id: 'branch-1',
  };
  const externalContext = (
    method: 'patch',
    data: unknown,
    options: {
      taskId?: string;
      executorTaskId?: string;
    } = {}
  ): import('@agor/core/types').HookContext =>
    ({
      path: 'tasks',
      method,
      id: options.taskId,
      data,
      params: {
        provider: 'rest',
        ...(options.executorTaskId
          ? {
              authentication: {
                payload: { ...executorPayload, task_id: options.executorTaskId },
              },
            }
          : {}),
      },
    }) as import('@agor/core/types').HookContext;

  it('rejects every normal-user patch, including terminality', async () => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext('patch', { status: TaskStatus.COMPLETED }, { taskId: 'task-1' })
      )
    ).rejects.toThrow('executor token scoped to this task');
  });

  it('rejects an executor token scoped to another task', async () => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext(
          'patch',
          { status: TaskStatus.COMPLETED },
          { taskId: 'task-1', executorTaskId: 'task-2' }
        )
      )
    ).rejects.toThrow('executor token scoped to this task');
  });

  it.each([
    'task_id',
    'session_id',
    'created_by',
    'queue_position',
    'sdk_failure',
  ])('rejects executor patch field %s outside the result allowlist', async (field) => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext(
          'patch',
          { [field]: 'forged' },
          {
            taskId: 'task-1',
            executorTaskId: 'task-1',
          }
        )
      )
    ).rejects.toThrow('not executor-managed');
  });

  it('allows a task-scoped executor to publish bounded result fields', async () => {
    await expect(
      protectServerManagedTaskWrites(
        externalContext(
          'patch',
          {
            status: TaskStatus.COMPLETED,
            completed_at: '2026-07-10T20:00:00.000Z',
            model: 'test-model',
            git_state: { sha_at_end: 'abc' },
          },
          {
            taskId: 'task-1',
            executorTaskId: 'task-1',
          }
        )
      )
    ).resolves.toBeDefined();
  });

  it.each([
    TaskStatus.AWAITING_PERMISSION,
    TaskStatus.AWAITING_INPUT,
  ])('allows a scoped executor to request resume from %s', async () => {
    const context = externalContext(
      'patch',
      { status: TaskStatus.RUNNING },
      {
        taskId: 'task-1',
        executorTaskId: 'task-1',
      }
    );

    await expect(protectServerManagedTaskWrites(context)).resolves.toBe(context);
  });

  it('preserves trusted internal direct-to-running task writes', async () => {
    const context = externalContext('patch', {
      status: TaskStatus.RUNNING,
    });
    context.params.provider = undefined;

    await expect(protectServerManagedTaskWrites(context)).resolves.toBe(context);
  });

  it('preserves trusted internal dispatching task writes', async () => {
    const context = externalContext('patch', {
      status: TaskStatus.DISPATCHING,
    });
    context.params.provider = undefined;

    await expect(protectServerManagedTaskWrites(context)).resolves.toBe(context);
  });
});

describe('tenant-owned service registration', () => {
  it('wraps gateway inbound routing in tenant database scope', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toContain('gateway');
  });

  it('wraps custom board archive routes in tenant database scope', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toEqual(
      expect.arrayContaining(['boards/:id/archive', 'boards/:id/unarchive'])
    );
  });

  it('wraps MCP OAuth/session helper services in tenant database scope', () => {
    expect(TENANT_OWNED_SERVICE_PATHS).toEqual(
      expect.arrayContaining([
        'sessions/:id/mcp-servers',
        'mcp-servers/discover',
        'mcp-servers/oauth-auth-headers',
        'mcp-servers/oauth-complete',
        'mcp-servers/oauth-disconnect',
        'mcp-servers/oauth-refresh',
        'mcp-servers/oauth-start',
        'mcp-servers/oauth-status',
        'mcp-servers/test-oauth',
      ])
    );
  });
});

describe('shouldValidateRepoEnvironmentPayload', () => {
  it('skips absent repo environment payloads', () => {
    expect(shouldValidateRepoEnvironmentPayload(undefined)).toBe(false);
    expect(shouldValidateRepoEnvironmentPayload(null)).toBe(false);
  });

  it('validates present repo environment payloads', () => {
    expect(shouldValidateRepoEnvironmentPayload({})).toBe(true);
    expect(shouldValidateRepoEnvironmentPayload('invalid shape')).toBe(true);
  });
});

describe('shouldRunSessionPostTurnHooks', () => {
  it('runs for idle sessions, preserving stop-route gateway finalization behavior', () => {
    expect(shouldRunSessionPostTurnHooks({ status: 'idle', ready_for_prompt: false })).toBe(true);
  });

  it('runs for failed sessions only once they are promptable', () => {
    expect(shouldRunSessionPostTurnHooks({ status: 'failed', ready_for_prompt: true })).toBe(true);
    expect(shouldRunSessionPostTurnHooks({ status: 'failed', ready_for_prompt: false })).toBe(
      false
    );
  });

  it('does not run for busy sessions', () => {
    expect(shouldRunSessionPostTurnHooks({ status: 'running', ready_for_prompt: false })).toBe(
      false
    );
  });
});

describe('getTrustedSessionTenantId', () => {
  it('reads non-enumerable tenant metadata from session DTOs without requiring JSON exposure', () => {
    const session = makeSession('session-1');
    Object.defineProperty(session, 'tenant_id', {
      value: 'tenant-from-row',
      enumerable: false,
    });

    expect(getTrustedSessionTenantId(session)).toBe('tenant-from-row');
    expect(Object.keys(session)).not.toContain('tenant_id');
    expect(JSON.stringify(session)).not.toContain('tenant_id');
  });

  it('ignores absent or empty tenant metadata', () => {
    expect(getTrustedSessionTenantId(makeSession('session-1'))).toBeUndefined();
    expect(getTrustedSessionTenantId({ tenant_id: '' })).toBeUndefined();
  });
});

describe('shouldDrainQueueAfterSessionPostTurnPatch', () => {
  it('drains for promptable ready sessions by default', () => {
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch({ status: 'failed', ready_for_prompt: true })
    ).toBe(true);
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch({ status: 'idle', ready_for_prompt: true })
    ).toBe(true);
  });

  it('does not drain when terminal queue processing is explicitly suppressed', () => {
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch(
        { status: 'failed', ready_for_prompt: true },
        { suppressTerminalQueueProcessing: true }
      )
    ).toBe(false);
  });

  it('does not drain for promptable-but-not-ready acknowledgement states', () => {
    expect(
      shouldDrainQueueAfterSessionPostTurnPatch({ status: 'idle', ready_for_prompt: false })
    ).toBe(false);
  });
});

describe('enrichSessionFindResultWithRemoteRelationships', () => {
  it('enriches paginated results produced by before.find RBAC scoping', async () => {
    const session = makeSession('session-1');
    const relationship = {
      relationship_id: 'relationship-1',
      source_session_id: 'session-1',
      target_session_id: 'session-2',
      relationship_type: 'remote_create',
      created_by: 'user-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      callback_enabled: false,
      callback_session_id: null,
      data: null,
    } as const;
    let calls = 0;
    const service = {
      async enrichRemoteRelationships(sessions: import('@agor/core/types').Session[]) {
        calls += 1;
        return sessions.map((item) =>
          item.session_id === session.session_id
            ? { ...item, remote_relationships: { as_source: [relationship], as_target: [] } }
            : item
        );
      },
    };

    const result = await enrichSessionFindResultWithRemoteRelationships(
      { total: 1, limit: 10, skip: 0, data: [session] },
      service
    );

    expect(calls).toBe(1);
    expect(Array.isArray(result)).toBe(false);
    expect(Array.isArray(result) ? null : result.data[0].remote_relationships?.as_source?.[0]).toBe(
      relationship
    );
  });

  it('does not enrich a result that the sessions service already enriched', async () => {
    const session = makeSession('session-1');
    let calls = 0;
    const service = {
      async enrichRemoteRelationships(sessions: import('@agor/core/types').Session[]) {
        calls += 1;
        return sessions.map((item) => ({ ...item, title: 'enriched twice' }));
      },
    };

    const once = await enrichSessionFindResultWithRemoteRelationships([session], service);
    const twice = await enrichSessionFindResultWithRemoteRelationships(once, service);

    expect(twice).toBe(once);
    expect(calls).toBe(1);
    expect((twice as import('@agor/core/types').Session[])[0].title).toBe('enriched twice');
  });
});

describe('isPromptFlowPatchOnly', () => {
  describe('accepts whitelisted-only patches', () => {
    it.each(
      PROMPT_FLOW_PATCH_FIELDS.map((f) => [f])
    )('accepts single whitelisted field: %s', (field) => {
      expect(isPromptFlowPatchOnly({ [field]: 'any-value' })).toBe(true);
    });

    it('accepts the prompt-route task-append shape', () => {
      // register-routes.ts: /sessions/:id/prompt appends task_id to session.tasks
      expect(isPromptFlowPatchOnly({ tasks: ['task-1', 'task-2'] })).toBe(true);
    });

    it('accepts the prompt-route auto-unarchive shape', () => {
      // register-routes.ts: /sessions/:id/prompt auto-unarchives before sending
      expect(isPromptFlowPatchOnly({ archived: false, archived_reason: undefined })).toBe(true);
    });

    it('accepts the stop-route idle shape', () => {
      // register-routes.ts: /sessions/:id/stop sets status + ready_for_prompt
      // (ready_for_prompt: true so the post-patch hook drains any QUEUED tasks)
      expect(isPromptFlowPatchOnly({ status: 'idle', ready_for_prompt: true })).toBe(true);
    });

    it('accepts the executor git-SHA capture shape', () => {
      // packages/executor/src/handlers/sdk/base-executor.ts patches current SHA
      expect(isPromptFlowPatchOnly({ git_state: { current_sha: 'deadbeef', ref: 'main' } })).toBe(
        true
      );
    });

    it('accepts the executor opencode init shape', () => {
      // packages/executor/src/handlers/sdk/opencode.ts patches the SDK session handle
      expect(isPromptFlowPatchOnly({ sdk_session_id: 'opencode-sess-123' })).toBe(true);
    });
  });

  describe('rejects mixed or metadata patches', () => {
    it('rejects a patch that mixes whitelist + metadata field', () => {
      // Prevents partial-trust escalation: if `tasks` is allowed at session-tier,
      // a caller must NOT be able to piggyback `name` (metadata) onto the same patch.
      expect(isPromptFlowPatchOnly({ tasks: ['t'], name: 'evil' })).toBe(false);
    });

    it.each([
      ['name', 'metadata'],
      ['model_config', { model: 'x' }],
      ['permission_config', { mode: 'bypass' }],
      ['callback_config', { callback_session_id: 'sid' }],
      ['created_by', 'other-user'],
      ['unix_username', 'root'],
      ['branch_id', 'wt-evil'],
    ])('rejects pure-metadata patch on field: %s', (field, value) => {
      expect(isPromptFlowPatchOnly({ [field]: value })).toBe(false);
    });
  });

  describe('rejects non-object inputs', () => {
    it('rejects null', () => {
      expect(isPromptFlowPatchOnly(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isPromptFlowPatchOnly(undefined)).toBe(false);
    });

    it('rejects empty object (nothing to patch = cannot be a prompt-flow patch)', () => {
      expect(isPromptFlowPatchOnly({})).toBe(false);
    });

    it('rejects primitives', () => {
      expect(isPromptFlowPatchOnly('string')).toBe(false);
      expect(isPromptFlowPatchOnly(42)).toBe(false);
      expect(isPromptFlowPatchOnly(true)).toBe(false);
    });
  });
});

/**
 * Guards the fix for CVE-class issue: `after: get` on /sessions was minting
 * an MCP token (with `uid = session.created_by`) for any `member+` caller
 * with `view` permission on the branch, letting them impersonate the
 * creator on the MCP channel. Only the creator, a superadmin, or the
 * executor's service identity may receive the token.
 */
describe('canReceiveMcpTokenForSession', () => {
  const CREATOR = 'user-creator';
  const OTHER = 'user-other';

  it('allows any authenticated member+ caller to receive a caller-scoped MCP token', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'member',
      })
    ).toBe(true);
  });

  it('allows a superadmin even if not the creator', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: OTHER,
        callerRole: 'superadmin',
      })
    ).toBe(true);
  });

  it('allows the executor service identity (role=service)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: 'executor-service',
        callerRole: 'service',
      })
    ).toBe(true);
  });

  it('denies a creator who has been demoted to viewer', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: CREATOR,
        callerRole: 'viewer',
      })
    ).toBe(false);
  });

  it('denies anonymous callers (no user_id, no role)', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: undefined,
        callerRole: undefined,
      })
    ).toBe(false);
  });

  it('denies callers with user_id but no explicit role', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: CREATOR,
        callerRole: undefined,
      })
    ).toBe(false);
  });

  it('denies empty-string caller user_id even with member role', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: '',
        callerRole: 'member',
      })
    ).toBe(false);
  });
});

describe('TENANT_IDENTITY_ONLY_SERVICE_PATHS', () => {
  // Regression: the codex-auth endpoints do network/process work after a short
  // tenant DB read, then call getCurrentTenantId() to open their own units of
  // work — so they must carry ambient tenant identity via the identity-only
  // around hook. codex-auth/logout was missing here, so `Remove login` ran with
  // no active tenant scope and threw "Missing active tenant context for Codex
  // auth logout" — the delete-only logout never worked end-to-end.
  it.each([
    'codex-auth/device',
    'codex-auth/import',
    'codex-auth/logout',
  ])('grants ambient tenant identity to %s', (path) => {
    expect(TENANT_IDENTITY_ONLY_SERVICE_PATHS).toContain(path);
  });

  it('keeps the codex-auth endpoints grouped together', () => {
    const codexPaths = TENANT_IDENTITY_ONLY_SERVICE_PATHS.filter((path) =>
      path.startsWith('codex-auth/')
    );
    expect(codexPaths).toEqual(['codex-auth/device', 'codex-auth/import', 'codex-auth/logout']);
  });
});
