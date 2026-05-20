/**
 * Unit tests for the widget resolution path.
 *
 * Tests the contract documented in §5 of the design doc:
 *   - Auth gating (session creator passes, non-owner without prompt-tier
 *     RBAC is rejected)
 *   - Idempotency (double-submit on a `submitted` widget is rejected)
 *   - Submit dispatches via the registry's applySubmit
 *   - Auto-resume task is queued via `/sessions/:id/prompt`
 *   - `auto_resume: false` skips the task creation
 *   - Dismissal path uses `buildDismissedPrompt`
 *   - WebSocket broadcast: `widget:resolved` fires
 *
 * No FeathersJS bootstrap — the resolver is pure-ish over a `deps.app`
 * mock, so we exercise the full state machine with a hand-rolled stub.
 */

import type { Message, Session, UserID, Worktree } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { _resetWidgetRegistryForTests, registerWidget, type WidgetRegistryEntry } from './registry';
import { canResolveWidget, resolveWidget } from './submissions';

interface MockServiceCall {
  service: string;
  method: 'get' | 'patch' | 'create';
  id?: string;
  data?: unknown;
  params?: unknown;
}

interface MockEvent {
  service: string;
  event: string;
  payload: unknown;
}

function makeApp(records: { message: Message; session: Session; worktree: Worktree }) {
  const calls: MockServiceCall[] = [];
  const events: MockEvent[] = [];
  let currentMessage = records.message;

  const services = {
    messages: {
      async get(id: string) {
        calls.push({ service: 'messages', method: 'get', id });
        if (id !== currentMessage.message_id) {
          throw new Error('Message not found');
        }
        return currentMessage;
      },
      async patch(id: string, data: Partial<Message>) {
        calls.push({ service: 'messages', method: 'patch', id, data });
        currentMessage = {
          ...currentMessage,
          metadata: { ...currentMessage.metadata, ...(data.metadata ?? {}) },
        };
        return currentMessage;
      },
      async create() {
        throw new Error('messages.create should not be called');
      },
      emit(event: string, payload: unknown) {
        events.push({ service: 'messages', event, payload });
      },
    },
    sessions: {
      async get() {
        calls.push({ service: 'sessions', method: 'get' });
        return records.session;
      },
      async patch() {
        throw new Error('sessions.patch should not be called');
      },
      async create() {
        throw new Error('sessions.create should not be called');
      },
    },
    worktrees: {
      async get() {
        calls.push({ service: 'worktrees', method: 'get' });
        return records.worktree;
      },
      async patch() {
        throw new Error('worktrees.patch should not be called');
      },
      async create() {
        throw new Error('worktrees.create should not be called');
      },
    },
    '/sessions/:id/prompt': {
      async get() {
        throw new Error('prompt.get should not be called');
      },
      async patch() {
        throw new Error('prompt.patch should not be called');
      },
      async create(data: unknown, params: unknown) {
        calls.push({
          service: '/sessions/:id/prompt',
          method: 'create',
          data,
          params,
        });
        return { task_id: 'task-mock' };
      },
    },
  };

  const app = {
    service(name: string) {
      const svc = services[name as keyof typeof services];
      if (!svc) throw new Error(`Mock app has no service '${name}'`);
      return svc;
    },
  };

  return {
    app,
    calls,
    events,
    get currentMessage() {
      return currentMessage;
    },
  };
}

function makeFixtures(
  opts: {
    widgetStatus?: 'pending' | 'submitted' | 'dismissed';
    widgetType?: string;
    autoResume?: boolean;
    sessionCreator?: UserID;
    worktreeOthersCan?: Worktree['others_can'];
  } = {}
) {
  const sessionCreator = (opts.sessionCreator ?? 'creator-user-id') as UserID;
  const message: Message = {
    message_id: 'widget-msg-1' as never,
    session_id: 'sess-1' as never,
    type: 'widget_request',
    role: 'system' as never,
    index: 5,
    timestamp: '2026-05-19T00:00:00.000Z',
    content_preview: 'Please provide HUBSPOT_API_KEY',
    content: 'Please provide HUBSPOT_API_KEY',
    metadata: {
      widget: {
        widget_id: 'widget-msg-1' as never,
        widget_type: opts.widgetType ?? 'env_vars',
        schema_version: 1,
        params: { names: ['HUBSPOT_API_KEY'], reason: 'call Hubspot' },
        status: opts.widgetStatus ?? 'pending',
        requested_at: '2026-05-19T00:00:00.000Z',
        ...(opts.autoResume !== undefined ? { auto_resume: opts.autoResume } : {}),
      },
    },
  };
  const session = {
    session_id: 'sess-1',
    worktree_id: 'wt-1',
    created_by: sessionCreator,
  } as unknown as Session;
  const worktree = {
    worktree_id: 'wt-1',
    name: 'feat-x',
    others_can: opts.worktreeOthersCan ?? 'session',
  } as unknown as Worktree;
  return { message, session, worktree };
}

function registerTestWidget(
  applySubmit = vi.fn(async (_ctx: unknown, _submit: unknown, _params: unknown) => {})
) {
  const entry: WidgetRegistryEntry<
    { names: string[]; reason: string },
    { value: string; scope: 'global' | 'session' },
    { names_submitted: string[]; scope: string }
  > = {
    type: 'env_vars',
    schemaVersion: 1,
    paramsSchema: z.object({
      names: z.array(z.string()),
      reason: z.string(),
    }),
    submitSchema: z.object({
      value: z.string(),
      scope: z.enum(['global', 'session']),
    }),
    buildResultMeta: (submit) => ({
      names_submitted: ['HUBSPOT_API_KEY'],
      scope: submit.scope,
    }),
    applySubmit,
    buildAutoResumePrompt: (rm) =>
      `[Agor] User submitted ${rm.names_submitted.join(', ')} (scope: ${rm.scope}).`,
    buildDismissedPrompt: (params) =>
      `[Agor] User dismissed the request for ${params.names.join(', ')}.`,
  };
  registerWidget(entry);
  return { entry, applySubmit };
}

describe('canResolveWidget', () => {
  it('allows the session creator', () => {
    const session = { created_by: 'alice' as UserID };
    const worktree = { others_can: 'view' } as unknown as Worktree;
    expect(canResolveWidget({ user_id: 'alice' as UserID }, session, worktree, false)).toBe(true);
  });

  it('rejects a non-creator with view-only RBAC', () => {
    const session = { created_by: 'alice' as UserID };
    const worktree = { others_can: 'view' } as unknown as Worktree;
    expect(canResolveWidget({ user_id: 'bob' as UserID }, session, worktree, false)).toBe(false);
  });

  it('rejects a non-creator with session-tier RBAC (session tier is for own sessions only)', () => {
    const session = { created_by: 'alice' as UserID };
    const worktree = { others_can: 'session' } as unknown as Worktree;
    expect(canResolveWidget({ user_id: 'bob' as UserID }, session, worktree, false)).toBe(false);
  });

  it('allows a non-creator with prompt-tier RBAC', () => {
    const session = { created_by: 'alice' as UserID };
    const worktree = { others_can: 'prompt' } as unknown as Worktree;
    expect(canResolveWidget({ user_id: 'bob' as UserID }, session, worktree, false)).toBe(true);
  });

  it('allows a non-creator with all-tier RBAC', () => {
    const session = { created_by: 'alice' as UserID };
    const worktree = { others_can: 'all' } as unknown as Worktree;
    expect(canResolveWidget({ user_id: 'bob' as UserID }, session, worktree, false)).toBe(true);
  });

  it('allows an explicit worktree owner even when others_can is view-only', () => {
    const session = { created_by: 'alice' as UserID };
    const worktree = { others_can: 'view' } as unknown as Worktree;
    expect(canResolveWidget({ user_id: 'bob' as UserID }, session, worktree, true)).toBe(true);
  });
});

describe('resolveWidget', () => {
  beforeEach(() => {
    _resetWidgetRegistryForTests();
  });

  it('submits a pending widget: dispatches to applySubmit, patches status, queues auto-resume, broadcasts', async () => {
    const { applySubmit } = registerTestWidget();
    const fixtures = makeFixtures();
    const { app, calls, events } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
      { user_id: 'creator-user-id' as UserID },
      { app: app as never, isWorktreeOwner: async () => false }
    );

    expect(result).toEqual({
      widget_id: 'widget-msg-1',
      status: 'submitted',
      auto_resume_queued: true,
    });
    expect(applySubmit).toHaveBeenCalledTimes(1);

    // Message was patched with submitted status + result_meta + resolved_at +
    // submitted_by. The secret value MUST NOT appear in the patch.
    const messagePatch = calls.find((c) => c.service === 'messages' && c.method === 'patch');
    expect(messagePatch).toBeDefined();
    const patchedData = messagePatch?.data as {
      metadata: {
        widget: { status: string; result_meta: { scope: string }; submitted_by: string };
      };
    };
    expect(patchedData.metadata.widget.status).toBe('submitted');
    expect(patchedData.metadata.widget.submitted_by).toBe('creator-user-id');
    expect(patchedData.metadata.widget.result_meta.scope).toBe('global');
    expect(JSON.stringify(patchedData)).not.toContain('secret-key');

    // Auto-resume task queued via /sessions/:id/prompt — same path as a
    // user-typed prompt. Prompt body must derive from result_meta only,
    // never the raw submit body.
    const promptCall = calls.find(
      (c) => c.service === '/sessions/:id/prompt' && c.method === 'create'
    );
    expect(promptCall).toBeDefined();
    const promptData = promptCall?.data as {
      prompt: string;
      metadata: { system_authored: boolean; widget_id: string };
    };
    expect(promptData.prompt).toContain('HUBSPOT_API_KEY');
    expect(promptData.prompt).toContain('global');
    expect(promptData.prompt).not.toContain('secret-key');
    expect(promptData.metadata.system_authored).toBe(true);
    expect(promptData.metadata.widget_id).toBe('widget-msg-1');

    // WebSocket event fired.
    const event = events.find((e) => e.event === 'widget:resolved');
    expect(event).toBeDefined();
    expect((event?.payload as { status: string }).status).toBe('submitted');
  });

  it('rejects a submission from a non-creator without prompt-tier RBAC', async () => {
    registerTestWidget();
    const fixtures = makeFixtures({ worktreeOthersCan: 'session' });
    const { app } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
        { user_id: 'someone-else' as UserID },
        { app: app as never, isWorktreeOwner: async () => false }
      )
    ).rejects.toThrow(/session creator|prompt/);
  });

  it('allows a submission from a non-creator with prompt-tier RBAC', async () => {
    registerTestWidget();
    const fixtures = makeFixtures({ worktreeOthersCan: 'prompt' });
    const { app } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
      { user_id: 'someone-else' as UserID },
      { app: app as never, isWorktreeOwner: async () => false }
    );
    expect(result.status).toBe('submitted');
  });

  it('rejects a double-submit (idempotency: status must be pending)', async () => {
    registerTestWidget();
    const fixtures = makeFixtures({ widgetStatus: 'submitted' });
    const { app } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'k', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        { app: app as never, isWorktreeOwner: async () => false }
      )
    ).rejects.toThrow(/already submitted/);
  });

  it('rejects an unknown widget type on submit (registry miss)', async () => {
    const fixtures = makeFixtures({ widgetType: 'unknown_type' });
    const { app } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: {} },
        { user_id: 'creator-user-id' as UserID },
        { app: app as never, isWorktreeOwner: async () => false }
      )
    ).rejects.toThrow(/not registered/);
  });

  it('skips auto-resume task when auto_resume: false', async () => {
    registerTestWidget();
    const fixtures = makeFixtures({ autoResume: false });
    const { app, calls } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'submit', body: { value: 'k', scope: 'global' } },
      { user_id: 'creator-user-id' as UserID },
      { app: app as never, isWorktreeOwner: async () => false }
    );

    expect(result.auto_resume_queued).toBe(false);
    expect(calls.find((c) => c.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it('dismisses a pending widget: uses buildDismissedPrompt, no applySubmit', async () => {
    const applySubmit = vi.fn(async () => {});
    registerTestWidget(applySubmit);
    const fixtures = makeFixtures();
    const { app, calls } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'dismiss' },
      { user_id: 'creator-user-id' as UserID },
      { app: app as never, isWorktreeOwner: async () => false }
    );

    expect(result.status).toBe('dismissed');
    expect(applySubmit).not.toHaveBeenCalled();

    const promptCall = calls.find(
      (c) => c.service === '/sessions/:id/prompt' && c.method === 'create'
    );
    expect(promptCall).toBeDefined();
    const promptData = promptCall?.data as { prompt: string };
    expect(promptData.prompt).toContain('dismissed');
  });

  it('dismissal works even for an unknown widget type (fallback prompt)', async () => {
    const fixtures = makeFixtures({ widgetType: 'unknown_type' });
    const { app, calls } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'dismiss' },
      { user_id: 'creator-user-id' as UserID },
      { app: app as never, isWorktreeOwner: async () => false }
    );

    expect(result.status).toBe('dismissed');
    const promptCall = calls.find(
      (c) => c.service === '/sessions/:id/prompt' && c.method === 'create'
    );
    const promptData = promptCall?.data as { prompt: string };
    expect(promptData.prompt).toContain('dismissed');
  });

  it('throws NotAuthenticated when caller is undefined', async () => {
    registerTestWidget();
    const fixtures = makeFixtures();
    const { app } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'k', scope: 'global' } },
        undefined,
        { app: app as never, isWorktreeOwner: async () => false }
      )
    ).rejects.toThrow(/Authentication/);
  });

  it('rejects an invalid submit body (Zod schema mismatch)', async () => {
    registerTestWidget();
    const fixtures = makeFixtures();
    const { app } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { scope: 'invalid-scope' } },
        { user_id: 'creator-user-id' as UserID },
        { app: app as never, isWorktreeOwner: async () => false }
      )
    ).rejects.toThrow(/Invalid submit/);
  });

  it('serializes concurrent resolutions on the same widget — only one applySubmit fires', async () => {
    const { applySubmit } = registerTestWidget();
    const fixtures = makeFixtures();
    const { app } = makeApp(fixtures);

    // Two callers hit submit in the same tick. The lock should let one
    // through to terminal state; the second sees `status !== 'pending'` and
    // rejects. applySubmit must only run ONCE.
    const [first, second] = await Promise.allSettled([
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'one', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        { app: app as never, isWorktreeOwner: async () => false }
      ),
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'two', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        { app: app as never, isWorktreeOwner: async () => false }
      ),
    ]);

    expect(applySubmit).toHaveBeenCalledTimes(1);
    const fulfilledCount = [first, second].filter((r) => r.status === 'fulfilled').length;
    const rejectedCount = [first, second].filter((r) => r.status === 'rejected').length;
    expect(fulfilledCount).toBe(1);
    expect(rejectedCount).toBe(1);
  });
});

describe('widget registry', () => {
  beforeEach(() => {
    _resetWidgetRegistryForTests();
  });

  it('starts empty in PR 1', async () => {
    const { listWidgetTypes } = await import('./registry');
    expect(listWidgetTypes()).toEqual([]);
  });

  it('refuses to register two widgets of the same type with different shapes', async () => {
    const { registerWidget: register } = await import('./registry');
    register({
      type: 'foo',
      schemaVersion: 1,
      paramsSchema: z.unknown(),
      submitSchema: z.unknown(),
      buildResultMeta: () => ({}),
      applySubmit: async () => {},
      buildAutoResumePrompt: () => '',
      buildDismissedPrompt: () => '',
    });
    expect(() =>
      register({
        type: 'foo',
        schemaVersion: 2,
        paramsSchema: z.unknown(),
        submitSchema: z.unknown(),
        buildResultMeta: () => ({}),
        applySubmit: async () => {},
        buildAutoResumePrompt: () => '',
        buildDismissedPrompt: () => '',
      })
    ).toThrow(/already registered/);
  });
});
