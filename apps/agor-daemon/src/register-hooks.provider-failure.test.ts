import type { HookContext, Message, MessageID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks';

type RegisteredHook = (context: HookContext) => HookContext | Promise<HookContext>;

function classifiedMessage(): Message {
  return {
    message_id: 'message-1' as MessageID,
    session_id: 'session-1' as never,
    type: 'system',
    role: MessageRole.SYSTEM,
    metadata: { error_kind: 'provider_credit_exhausted', tool: 'claude-code' },
  } as Message;
}

function ordinaryMessage(): Message {
  return {
    ...classifiedMessage(),
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    content: 'existing content',
    content_preview: 'existing preview',
    metadata: {},
  };
}

function captureMessageHooks(existing: Message) {
  const captured: Partial<Record<'all' | 'create' | 'patch' | 'update', RegisteredHook[]>> = {};
  const findByIdForScopeCheck = vi.fn().mockResolvedValue(existing);
  const app = {
    service(path: string) {
      return {
        hooks(hooks: { before?: Record<string, RegisteredHook[]> }) {
          if (path !== 'messages') return;
          for (const [method, chain] of Object.entries(hooks.before ?? {})) {
            if (
              method === 'all' ||
              method === 'create' ||
              method === 'patch' ||
              method === 'update'
            ) {
              captured[method] = [...(captured[method] ?? []), ...(chain ?? [])];
            }
          }
        },
      };
    },
    use() {},
    publish() {},
  };

  registerHooks({
    db: {} as RegisterHooksContext['db'],
    app: app as unknown as RegisterHooksContext['app'],
    config: {
      database: { dialect: 'postgresql' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'provider-failure-test' },
    } as RegisterHooksContext['config'],
    jwtSecret: 'provider-failure-test-secret',
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    messagesService: {
      findByIdForScopeCheck,
    } as unknown as RegisterHooksContext['messagesService'],
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    boardsService: undefined,
    branchRepository: {
      findById: vi.fn(async () => ({
        branch_id: 'branch-1',
        created_by: 'user-1',
        primary_owner_user_id: 'user-1',
      })),
      isOwner: vi.fn(async () => true),
      resolveUserPermission: vi.fn(async () => 'all'),
      resolveSessionPromptAuthority: vi.fn(async () => ({
        allowed: true,
        source: 'owner',
        execution_user_id: 'user-1',
      })),
    } as unknown as RegisterHooksContext['branchRepository'],
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {
      findById: vi.fn(async () => ({
        session_id: 'session-1',
        branch_id: 'branch-1',
        created_by: 'user-1',
        sdk_home_scope: 'branch',
      })),
    } as unknown as RegisterHooksContext['sessionsRepository'],
    deployment: { mode: 'standalone' },
  });

  return { captured, findByIdForScopeCheck };
}

async function runRegisteredMessageHooks(
  hooks: RegisteredHook[],
  method: 'create' | 'patch' | 'update',
  data: Record<string, unknown>
): Promise<HookContext> {
  const context = {
    path: 'messages',
    method,
    id: 'message-1',
    data,
    params: {
      provider: 'rest',
      query: {},
      user: { user_id: 'user-1', role: 'member' },
    },
    service: {
      get: vi.fn(async () => ({ message_id: 'message-1', session_id: 'session-1' })),
    },
  } as unknown as HookContext;

  for (const hook of hooks) await hook(context);
  return context;
}

describe('registered provider failure message boundary', () => {
  it('rejects forged recovery metadata through the registered create hooks', async () => {
    const { captured } = captureMessageHooks(classifiedMessage());

    await expect(
      runRegisteredMessageHooks([...(captured.all ?? []), ...(captured.create ?? [])], 'create', {
        message_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
        session_id: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a70',
        type: 'system',
        role: MessageRole.SYSTEM,
        index: 0,
        timestamp: '2026-08-14T00:00:00.000Z',
        content_preview: 'forged provider recovery',
        content: 'forged provider recovery',
        metadata: { error_kind: 'provider_credit_exhausted', tool: 'claude-code' },
      })
    ).rejects.toMatchObject({ name: 'Forbidden' });
  });

  it.each([
    ['clearing metadata', { metadata: {} }],
    ['changing the classified tool', { metadata: { tool: 'codex' } }],
    ['changing the message type', { type: 'assistant' }],
    ['changing the message role', { role: 'assistant' }],
    ['clearing content', { content: '' }],
    ['clearing content preview', { content_preview: '' }],
  ])('rejects an external patch that attempts %s', async (_label, data) => {
    const { captured, findByIdForScopeCheck } = captureMessageHooks(classifiedMessage());

    await expect(
      runRegisteredMessageHooks([...(captured.all ?? []), ...(captured.patch ?? [])], 'patch', data)
    ).rejects.toMatchObject({ name: 'Forbidden' });
    expect(findByIdForScopeCheck).toHaveBeenCalledWith('message-1');
  });

  it('keeps ordinary external message patches available', async () => {
    const { captured, findByIdForScopeCheck } = captureMessageHooks(ordinaryMessage());

    await expect(
      runRegisteredMessageHooks([...(captured.all ?? []), ...(captured.patch ?? [])], 'patch', {
        content: 'edited',
        content_preview: 'edited preview',
      })
    ).resolves.toBeDefined();
    expect(findByIdForScopeCheck).toHaveBeenCalledWith('message-1');
  });

  it('keeps external whole-row replacement blocked by the registered message boundary', async () => {
    const { captured } = captureMessageHooks(classifiedMessage());

    await expect(
      runRegisteredMessageHooks([...(captured.all ?? []), ...(captured.update ?? [])], 'update', {
        type: 'assistant',
        role: 'assistant',
        metadata: {},
      })
    ).rejects.toMatchObject({ name: 'Forbidden' });
  });
});
