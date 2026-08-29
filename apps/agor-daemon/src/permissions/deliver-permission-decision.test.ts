import { NotFound } from '@agor/core/feathers';
import type { BranchPermissionLevel, Message, SessionID, TaskID } from '@agor/core/types';
import { PermissionScope, PermissionStatus, ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  deliverPermissionDecision,
  type PermissionDecisionSubmission,
} from './deliver-permission-decision.js';

const SESSION_ID = '00000000-0000-7000-8000-000000000001' as SessionID;
const TASK_ID = '00000000-0000-7000-8000-000000000002' as TaskID;

function permissionMessage(status = PermissionStatus.PENDING): Message {
  return {
    message_id: '00000000-0000-7000-8000-000000000003',
    session_id: SESSION_ID,
    task_id: TASK_ID,
    type: 'permission_request',
    role: 'system',
    index: 1,
    timestamp: '2026-08-10T00:00:00.000Z',
    content_preview: 'Permission required: Bash',
    content: {
      request_id: 'request-1',
      task_id: TASK_ID,
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
      status,
    },
  } as Message;
}

function harness(
  message = permissionMessage(),
  options: {
    branchRbacEnabled?: boolean;
    branchPermission?: BranchPermissionLevel;
    sessionCreatedBy?: string;
  } = {}
) {
  const sessions = {
    get: vi.fn().mockResolvedValue({
      session_id: SESSION_ID,
      branch_id: 'branch-a',
      created_by: options.sessionCreatedBy ?? 'user-a',
    }),
  };
  const messages = {
    findByTask: vi.fn().mockResolvedValue([message]),
    emit: vi.fn(),
    patch: vi.fn(),
  };
  const app = {
    service(path: string) {
      if (path === 'sessions') return sessions;
      if (path === 'messages') return messages;
      throw new Error(`Unexpected service ${path}`);
    },
  } as never;
  const params = {
    provider: 'socketio',
    tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    user: { user_id: 'user-a', role: ROLES.MEMBER },
  } as never;
  const branchRepository = {
    findById: vi.fn().mockResolvedValue({
      branch_id: 'branch-a',
      name: 'Branch A',
      others_can: options.branchPermission ?? 'prompt',
    }),
    isOwner: vi.fn().mockResolvedValue(false),
    resolveUserPermission: vi.fn().mockResolvedValue(options.branchPermission ?? 'prompt'),
    resolveSessionPromptAuthority: vi.fn().mockResolvedValue({
      allowed:
        ['session', 'prompt', 'all'].includes(options.branchPermission ?? 'prompt') &&
        (options.sessionCreatedBy ?? 'user-a') === 'user-a',
      execution_user_id: 'user-a',
      source: (options.sessionCreatedBy ?? 'user-a') === 'user-a' ? 'own_session' : 'denied',
    }),
  };
  const authorization = {
    branchRbacEnabled: options.branchRbacEnabled ?? false,
    branchRepository,
    allowSuperadmin: true,
  } as never;
  return { app, authorization, branchRepository, messages, params, sessions };
}

function submission(
  overrides: Partial<PermissionDecisionSubmission> = {}
): PermissionDecisionSubmission {
  return {
    requestId: 'request-1',
    taskId: TASK_ID,
    allow: true,
    reason: 'Approved by user',
    remember: false,
    scope: PermissionScope.PROJECT,
    decidedBy: 'attacker-controlled-user',
    ...overrides,
  };
}

describe('deliverPermissionDecision', () => {
  it('keeps standalone delivery retryable and lets the executor commit the outcome', async () => {
    const { app, authorization, messages, params, sessions } = harness();

    await expect(
      deliverPermissionDecision({
        app,
        sessionId: SESSION_ID,
        data: submission(),
        params,
        authorization,
      })
    ).resolves.toEqual({ success: true });

    expect(sessions.get).toHaveBeenCalledWith(SESSION_ID, params);
    expect(messages.findByTask).toHaveBeenCalledWith(TASK_ID);
    expect(messages.patch).not.toHaveBeenCalled();
    expect(messages.emit).toHaveBeenCalledOnce();

    const [event, payload, hook] = messages.emit.mock.calls[0]!;
    expect(event).toBe('permission_resolved');
    expect(payload).toEqual({
      requestId: 'request-1',
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      allow: true,
      reason: 'Approved by user',
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'user-a',
    });
    expect(hook).toMatchObject({
      path: 'messages',
      event: 'permission_resolved',
      method: 'patch',
      params: { tenant: params.tenant, user: params.user },
    });
  });

  it('fails closed before lookup or delivery when the hooked Session read denies access', async () => {
    const { app, authorization, messages, params, sessions } = harness();
    sessions.get.mockRejectedValue(new NotFound('Session not found'));

    await expect(
      deliverPermissionDecision({
        app,
        sessionId: SESSION_ID,
        data: submission(),
        params,
        authorization,
      })
    ).rejects.toThrow('Session not found');
    expect(messages.findByTask).not.toHaveBeenCalled();
    expect(messages.emit).not.toHaveBeenCalled();
  });

  it('does not redeliver after the executor has committed the Message outcome', async () => {
    const { app, authorization, messages, params } = harness(
      permissionMessage(PermissionStatus.APPROVED)
    );

    await expect(
      deliverPermissionDecision({
        app,
        sessionId: SESSION_ID,
        data: submission(),
        params,
        authorization,
      })
    ).resolves.toEqual({
      success: false,
      alreadyResolved: true,
      status: PermissionStatus.APPROVED,
      message: 'Permission request already approved',
    });
    expect(messages.emit).not.toHaveBeenCalled();
  });

  it('does not let a changed client Task selector authorize the persisted request', async () => {
    const { app, authorization, messages, params } = harness();
    messages.findByTask.mockResolvedValue([]);

    await expect(
      deliverPermissionDecision({
        app,
        sessionId: SESSION_ID,
        data: submission({ taskId: '00000000-0000-7000-8000-000000000099' as TaskID }),
        params,
        authorization,
      })
    ).rejects.toThrow('not found');
    expect(messages.emit).not.toHaveBeenCalled();
  });

  it('rejects a forged persistent scope instead of widening the one-shot grant', async () => {
    const { app, authorization, messages, params } = harness();

    await expect(
      deliverPermissionDecision({
        app,
        sessionId: SESSION_ID,
        data: submission({ remember: true, scope: 'session' as PermissionScope }),
        params,
        authorization,
      })
    ).rejects.toThrow('valid scope');
    expect(messages.emit).not.toHaveBeenCalled();
  });

  it('denies a view-only collaborator before delivering an execution decision', async () => {
    const { app, authorization, messages, params } = harness(permissionMessage(), {
      branchRbacEnabled: true,
      branchPermission: 'view',
      sessionCreatedBy: 'user-b',
    });

    await expect(
      deliverPermissionDecision({
        app,
        sessionId: SESSION_ID,
        data: submission(),
        params,
        authorization,
      })
    ).rejects.toThrow(/don't have permission to prompt this branch/i);
    expect(messages.findByTask).not.toHaveBeenCalled();
    expect(messages.emit).not.toHaveBeenCalled();
  });

  it('allows session-tier users to decide permissions only for their own Session', async () => {
    const { app, authorization, messages, params } = harness(permissionMessage(), {
      branchRbacEnabled: true,
      branchPermission: 'session',
      sessionCreatedBy: 'user-a',
    });

    await expect(
      deliverPermissionDecision({
        app,
        sessionId: SESSION_ID,
        data: submission(),
        params,
        authorization,
      })
    ).resolves.toEqual({ success: true });
    expect(messages.emit).toHaveBeenCalledOnce();
  });

  it('rejects a permission Message whose nested and canonical Task bindings differ', async () => {
    const message = permissionMessage();
    (message.content as { task_id: string }).task_id = '00000000-0000-7000-8000-000000000099';
    const { app, authorization, messages, params } = harness(message);

    await expect(
      deliverPermissionDecision({
        app,
        sessionId: SESSION_ID,
        data: submission(),
        params,
        authorization,
      })
    ).rejects.toThrow('Task binding is inconsistent');
    expect(messages.emit).not.toHaveBeenCalled();
  });
});
