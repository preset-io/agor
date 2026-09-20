/**
 * Unit tests for the widget resolution path.
 *
 * Tests the contract documented in §5 of the design doc:
 *   - Auth gating delegates to the canonical prompt authority decision
 *   - Idempotency (double-submit on a `submitted` widget is rejected)
 *   - Submit dispatches via the registry's applySubmit
 *   - Auto-resume task is queued via `/sessions/:id/prompt`
 *   - `auto_resume: false` skips the task creation
 *   - Dismissal path uses `buildDismissedPrompt`
 *   - WebSocket broadcast: `widget:resolved` fires
 *   - OAuth lane: `/oauth-resolve` dispatches to `resolveFromDaemonVerification`,
 *     reuses the SAME claim / auto-resume / broadcast machinery, and the two
 *     resolution kinds cannot be reached through each other's endpoint
 *
 * No FeathersJS bootstrap — the resolver is pure-ish over a `deps.app`
 * mock, so we exercise the full state machine with a hand-rolled stub.
 */

import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type { Branch, Message, MessageID, Session, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { widgetAutoResumeTaskId } from '../utils/durable-task-id.js';
import { _resetWidgetRegistryForTests, registerWidget, type WidgetRegistryEntry } from './registry';
import { WidgetResolutionStore } from './resolution-store';
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

const runInTenantDatabaseScope = <T>(work: () => Promise<T>) => work();
const allowPrompt = async () =>
  ({ allowed: true, execution_user_id: 'creator-user-id', source: 'own_session' }) as const;
const denyPrompt = async () => ({ allowed: false, source: 'denied' }) as const;

function makeApp(
  records: { message: Message; session: Session; branch: Branch },
  options: {
    promptCreate?: (data: unknown, params: unknown) => Promise<unknown>;
  } = {}
) {
  const calls: MockServiceCall[] = [];
  const events: MockEvent[] = [];
  let currentMessage = records.message;
  const resolutionStore = new WidgetResolutionStore({
    async mutateMetadataLocked(_id, mutation) {
      const metadata = mutation(currentMessage.metadata, currentMessage);
      if (metadata === null) return { changed: false, message: currentMessage };
      currentMessage = { ...currentMessage, metadata };
      calls.push({
        service: 'messages',
        method: 'patch',
        id: currentMessage.message_id,
        data: { metadata },
      });
      return { changed: true, message: currentMessage };
    },
  });

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
    branches: {
      async get() {
        calls.push({ service: 'branches', method: 'get' });
        return records.branch;
      },
      async patch() {
        throw new Error('branches.patch should not be called');
      },
      async create() {
        throw new Error('branches.create should not be called');
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
        if (options.promptCreate) return options.promptCreate(data, params);
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
    resolutionStore,
    calls,
    events,
    get currentMessage() {
      return currentMessage;
    },
  };
}

function makeFixtures(
  opts: {
    widgetStatus?: 'pending' | 'submitted' | 'dismissed' | 'resolving';
    widgetType?: string;
    autoResume?: boolean;
    sessionCreator?: UserID;
    branchOthersCan?: Branch['others_can'];
    /** A claim someone else took and never finished. */
    resolutionClaim?: {
      token: string;
      action: 'submit' | 'dismiss' | 'oauth_callback';
      claimed_at: string;
      claimed_by: UserID;
    };
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
        ...(opts.resolutionClaim ? { resolution_claim: opts.resolutionClaim } : {}),
      },
    },
  };
  const session = {
    session_id: 'sess-1',
    branch_id: 'wt-1',
    created_by: sessionCreator,
  } as unknown as Session;
  const branch = {
    branch_id: 'wt-1',
    name: 'feat-x',
    others_can: opts.branchOthersCan ?? 'session',
  } as unknown as Branch;
  return { message, session, branch };
}

type TestWidgetEntry = WidgetRegistryEntry<
  { names: string[]; reason: string },
  { value: string; scope: 'global' | 'session' },
  { names_submitted: string[]; scope: string }
>;

function registerTestWidget(
  applySubmit = vi.fn(async (_ctx: unknown, _submit: unknown, _params: unknown) => {}),
  authorizeDismiss?: TestWidgetEntry['authorizeDismiss']
) {
  const entry: TestWidgetEntry = {
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
    ...(authorizeDismiss ? { authorizeDismiss } : {}),
  };
  registerWidget(entry);
  return { entry, applySubmit };
}

/**
 * A body-taking widget whose outcome is NOT derivable from the body.
 *
 * Stands in for `gateway_token`, whose enable decision comes from a credential
 * probe inside `applySubmit`. Its `buildResultMeta` deliberately answers
 * something different, so a test can tell which source the resolver used
 * rather than having both agree by construction.
 */
type ProbeWidgetResultMeta = { names_submitted: string[]; scope: string; verified?: boolean };

function registerProbeWidget(options: { handlerReturnsMeta: boolean }) {
  const applySubmit = vi.fn(
    async (
      _ctx: unknown,
      submit: { value: string; scope: 'global' | 'session' },
      params: { names: string[] }
    ) =>
      options.handlerReturnsMeta
        ? { names_submitted: params.names, scope: submit.scope, verified: true }
        : undefined
  );
  const buildResultMeta = vi.fn((submit: { scope: 'global' | 'session' }) => ({
    names_submitted: ['FROM_THE_BODY'],
    scope: submit.scope,
  }));
  const buildAutoResumePrompt = vi.fn(
    (rm: ProbeWidgetResultMeta) =>
      `[Agor] User submitted ${rm.names_submitted.join(', ')} ` +
      `(scope: ${rm.scope}, verified: ${String(rm.verified ?? false)}).`
  );
  const entry: WidgetRegistryEntry<
    { names: string[]; reason: string },
    { value: string; scope: 'global' | 'session' },
    ProbeWidgetResultMeta
  > = {
    type: 'env_vars',
    schemaVersion: 1,
    paramsSchema: z.object({ names: z.array(z.string()), reason: z.string() }),
    submitSchema: z.object({ value: z.string(), scope: z.enum(['global', 'session']) }),
    buildResultMeta,
    applySubmit,
    buildAutoResumePrompt,
    buildDismissedPrompt: () => '[Agor] User dismissed.',
  };
  registerWidget(entry);
  return { applySubmit, buildResultMeta, buildAutoResumePrompt };
}

describe('canResolveWidget', () => {
  it('allows an affirmative canonical prompt decision', () => {
    expect(canResolveWidget({ allowed: true })).toBe(true);
  });

  it('rejects a denied canonical prompt decision', () => {
    expect(canResolveWidget({ allowed: false })).toBe(false);
  });
});

describe('resolveWidget', () => {
  beforeEach(() => {
    _resetWidgetRegistryForTests();
  });

  it('does not read authorization context for a non-widget message', async () => {
    const fixtures = makeFixtures();
    fixtures.message.type = 'user';
    const { app, calls, resolutionStore } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'dismiss' },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toThrow('is not a widget request');
    expect(calls.map((call) => call.service)).toEqual(['messages']);
  });

  it('propagates message infrastructure errors instead of translating them to not found', async () => {
    const infrastructureError = new Error('database unavailable');
    const app = {
      service: () => ({ get: async () => Promise.reject(infrastructureError) }),
    };
    const resolutionStore = {} as WidgetResolutionStore;

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'dismiss' },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toBe(infrastructureError);
  });

  it('narrows message not-found errors to the widget lookup', async () => {
    const app = {
      service: () => ({ get: async () => Promise.reject(new NotFound('missing message')) }),
    };
    const resolutionStore = {} as WidgetResolutionStore;

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'dismiss' },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toThrow('Widget widget-msg-1 not found');
  });

  it('submits a pending widget: dispatches to applySubmit, patches status, queues auto-resume, broadcasts', async () => {
    const { applySubmit } = registerTestWidget();
    const fixtures = makeFixtures();
    const { app, calls, events, resolutionStore } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
      { user_id: 'creator-user-id' as UserID },
      {
        app: app as never,
        resolutionStore,
        runInTenantDatabaseScope,
        resolveSessionPromptAuthority: allowPrompt,
      }
    );

    expect(result).toEqual({
      widget_id: 'widget-msg-1',
      status: 'submitted',
      auto_resume_queued: true,
    });
    expect(applySubmit).toHaveBeenCalledTimes(1);

    // Message was patched with submitted status + result_meta + resolved_at +
    // submitted_by. The secret value MUST NOT appear in the patch.
    const messagePatch = calls
      .filter(
        (c) =>
          c.service === 'messages' &&
          c.method === 'patch' &&
          (c.data as { metadata?: { widget?: { status?: string } } }).metadata?.widget?.status ===
            'submitted'
      )
      .at(-1);
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
      idempotencyTaskId: string;
      metadata: {
        system_authored: boolean;
        widget_id: string;
        widget_resolved_by_user_id: string;
      };
    };
    expect(promptData.prompt).toContain('HUBSPOT_API_KEY');
    expect(promptData.prompt).toContain('global');
    expect(promptData.prompt).not.toContain('secret-key');
    expect(promptData.metadata.system_authored).toBe(true);
    expect(promptData.metadata.widget_id).toBe('widget-msg-1');
    expect(promptData.metadata.widget_resolved_by_user_id).toBe('creator-user-id');
    expect(promptData.idempotencyTaskId).toBe(widgetAutoResumeTaskId('widget-msg-1' as MessageID));
    expect(promptData.idempotencyTaskId).not.toBe('widget-msg-1');
    expect(calls.indexOf(promptCall!)).toBeLessThan(calls.indexOf(messagePatch!));

    // WebSocket event fired.
    const event = events.find((e) => e.event === 'widget:resolved');
    expect(event).toBeDefined();
    expect((event!.payload as { status: string }).status).toBe('submitted');
  });

  it('carries a handler-returned result_meta into the prompt, the row, and the broadcast', async () => {
    // The axis this variant exists for: `gateway_token`'s outcome is decided
    // by a probe inside the handler, not by the body. Before `applySubmit`
    // could return one, that outcome reached `buildResultMeta` through a
    // module-level WeakMap keyed on submit-object identity.
    const { buildResultMeta, buildAutoResumePrompt } = registerProbeWidget({
      handlerReturnsMeta: true,
    });
    const fixtures = makeFixtures();
    const { app, calls, events, resolutionStore } = makeApp(fixtures);

    await resolveWidget(
      'widget-msg-1',
      { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
      { user_id: 'creator-user-id' as UserID },
      {
        app: app as never,
        resolutionStore,
        runInTenantDatabaseScope,
        resolveSessionPromptAuthority: allowPrompt,
      }
    );

    // The handler's answer won, and the body-only builder was never consulted.
    expect(buildResultMeta).not.toHaveBeenCalled();
    expect(buildAutoResumePrompt).toHaveBeenCalledTimes(1);
    const [promptMeta, promptParams] = buildAutoResumePrompt.mock.calls[0];
    expect(promptMeta).toEqual({
      names_submitted: ['HUBSPOT_API_KEY'],
      scope: 'global',
      verified: true,
    });
    // The prompt builder receives result_meta and params — never the body.
    // `value` is the only place the secret lives, so its absence from both
    // arguments is the invariant, not just its absence from the rendered text.
    expect(JSON.stringify([promptMeta, promptParams])).not.toContain('secret-key');
    expect(promptMeta).not.toHaveProperty('value');

    const promptCall = calls.find(
      (c) => c.service === '/sessions/:id/prompt' && c.method === 'create'
    );
    const promptData = promptCall?.data as { prompt: string };
    expect(promptData.prompt).toContain('verified: true');
    expect(promptData.prompt).not.toContain('FROM_THE_BODY');
    expect(promptData.prompt).not.toContain('secret-key');

    const messagePatch = calls
      .filter(
        (c) =>
          c.service === 'messages' &&
          c.method === 'patch' &&
          (c.data as { metadata?: { widget?: { status?: string } } }).metadata?.widget?.status ===
            'submitted'
      )
      .at(-1);
    const patched = messagePatch?.data as {
      metadata: { widget: { result_meta: ProbeWidgetResultMeta } };
    };
    expect(patched.metadata.widget.result_meta.verified).toBe(true);
    expect(JSON.stringify(patched)).not.toContain('secret-key');

    const event = events.find((e) => e.event === 'widget:resolved');
    const payload = event!.payload as { result_meta: ProbeWidgetResultMeta };
    expect(payload.result_meta.verified).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('secret-key');
  });

  it('falls back to buildResultMeta when the handler returns nothing', async () => {
    // The other half of the contract: a meta that IS a pure projection of the
    // body (env_vars) still comes from the builder, and the builder is the
    // only thing the body is handed to.
    const { buildResultMeta, buildAutoResumePrompt } = registerProbeWidget({
      handlerReturnsMeta: false,
    });
    const fixtures = makeFixtures();
    const { app, calls, resolutionStore } = makeApp(fixtures);

    await resolveWidget(
      'widget-msg-1',
      { kind: 'submit', body: { value: 'secret-key', scope: 'session' } },
      { user_id: 'creator-user-id' as UserID },
      {
        app: app as never,
        resolutionStore,
        runInTenantDatabaseScope,
        resolveSessionPromptAuthority: allowPrompt,
      }
    );

    expect(buildResultMeta).toHaveBeenCalledTimes(1);
    expect(buildResultMeta).toHaveBeenCalledWith({ value: 'secret-key', scope: 'session' });
    const [promptMeta] = buildAutoResumePrompt.mock.calls[0];
    expect(promptMeta).toEqual({ names_submitted: ['FROM_THE_BODY'], scope: 'session' });
    expect(JSON.stringify(promptMeta)).not.toContain('secret-key');

    const promptCall = calls.find(
      (c) => c.service === '/sessions/:id/prompt' && c.method === 'create'
    );
    const fallbackPrompt = (promptCall?.data as { prompt: string } | undefined)?.prompt;
    expect(fallbackPrompt).toContain('FROM_THE_BODY');
    expect(fallbackPrompt).not.toContain('secret-key');
  });

  it('rejects a submission when canonical prompt authority denies it', async () => {
    registerTestWidget();
    const fixtures = makeFixtures({ branchOthersCan: 'session' });
    const { app, resolutionStore } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
        { user_id: 'someone-else' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: denyPrompt,
        }
      )
    ).rejects.toThrow(/don't have permission to prompt this branch/i);
  });

  it('rechecks prompt authority after submit effects and fails closed before auto-resume', async () => {
    const { applySubmit } = registerTestWidget();
    const fixtures = makeFixtures({ sessionCreator: 'session-owner' as UserID });
    const harness = makeApp(fixtures);
    const { app, calls, resolutionStore } = harness;
    const resolveSessionPromptAuthority = vi
      .fn()
      .mockResolvedValueOnce({
        allowed: true,
        execution_user_id: 'session-owner',
        source: 'branch_session',
      })
      .mockResolvedValueOnce({ allowed: false, source: 'denied' });

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
        { user_id: 'someone-else' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority,
        }
      )
    ).rejects.toThrow(/don't have permission to prompt this branch/i);

    expect(resolveSessionPromptAuthority).toHaveBeenCalledTimes(2);
    expect(applySubmit).toHaveBeenCalledOnce();
    expect(
      calls.some((call) => call.service === '/sessions/:id/prompt' && call.method === 'create')
    ).toBe(false);
    expect(harness.currentMessage.metadata?.widget?.status).toBe('resolving');
  });

  it('allows a submission when shared-session prompting is authorized', async () => {
    registerTestWidget();
    const fixtures = makeFixtures({ branchOthersCan: 'prompt' });
    const { app, calls, resolutionStore } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
      { user_id: 'someone-else' as UserID },
      {
        app: app as never,
        resolutionStore,
        runInTenantDatabaseScope,
        resolveSessionPromptAuthority: allowPrompt,
      }
    );
    expect(result.status).toBe('submitted');
    const promptCall = calls.find(
      (call) => call.service === '/sessions/:id/prompt' && call.method === 'create'
    );
    expect(promptCall?.params).toMatchObject({ user: { user_id: 'someone-else' } });
    expect(promptCall?.data).toMatchObject({
      metadata: { widget_resolved_by_user_id: 'someone-else' },
    });
  });

  it('rejects a double-submit (idempotency: status must be pending)', async () => {
    registerTestWidget();
    const fixtures = makeFixtures({ widgetStatus: 'submitted' });
    const { app, resolutionStore } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'k', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toThrow(/already submitted/);
  });

  it('rejects an unknown widget type on submit (registry miss)', async () => {
    const fixtures = makeFixtures({ widgetType: 'unknown_type' });
    const { app, resolutionStore } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: {} },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toThrow(/not registered/);
  });

  it('skips auto-resume task when auto_resume: false', async () => {
    registerTestWidget();
    const fixtures = makeFixtures({ autoResume: false });
    const { app, calls, resolutionStore } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'submit', body: { value: 'k', scope: 'global' } },
      { user_id: 'creator-user-id' as UserID },
      {
        app: app as never,
        resolutionStore,
        runInTenantDatabaseScope,
        resolveSessionPromptAuthority: allowPrompt,
      }
    );

    expect(result.auto_resume_queued).toBe(false);
    expect(calls.find((c) => c.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it('dismisses a pending widget: uses buildDismissedPrompt, no applySubmit', async () => {
    const applySubmit = vi.fn(async () => {});
    registerTestWidget(applySubmit);
    const fixtures = makeFixtures();
    const { app, calls, resolutionStore } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'dismiss' },
      { user_id: 'creator-user-id' as UserID },
      {
        app: app as never,
        resolutionStore,
        runInTenantDatabaseScope,
        resolveSessionPromptAuthority: allowPrompt,
      }
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
    const { app, calls, resolutionStore } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'dismiss' },
      { user_id: 'creator-user-id' as UserID },
      {
        app: app as never,
        resolutionStore,
        runInTenantDatabaseScope,
        resolveSessionPromptAuthority: allowPrompt,
      }
    );

    expect(result.status).toBe('dismissed');
    const promptCall = calls.find(
      (c) => c.service === '/sessions/:id/prompt' && c.method === 'create'
    );
    const promptData = promptCall?.data as { prompt: string };
    expect(promptData.prompt).toContain('dismissed');
  });

  it('rejects a dismissal that the widget authorizeDismiss denies, leaving it pending', async () => {
    // A non-admin session creator passes the resolve-endpoint RBAC, but an
    // admin-only widget's authorizeDismiss must still block the dismiss.
    registerTestWidget(undefined, (ctx) => {
      if (ctx.submitterRole !== 'admin') {
        throw new Error('Only admins can decline this request');
      }
    });
    const fixtures = makeFixtures();
    const { app, calls, resolutionStore } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'dismiss' },
        { user_id: 'creator-user-id' as UserID, role: 'member' },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toThrow(/admin/i);

    // No status patch on a rejected dismiss — the widget stays pending.
    expect(calls.find((c) => c.service === 'messages' && c.method === 'patch')).toBeUndefined();
  });

  it('rejects a dismissal from an undefined-role caller, leaving it pending', async () => {
    // Same endpoint path, but the caller carries no role at all (fails closed).
    registerTestWidget(undefined, (ctx) => {
      if (ctx.submitterRole !== 'admin') {
        throw new Error('Only admins can decline this request');
      }
    });
    const fixtures = makeFixtures();
    const { app, calls, resolutionStore } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'dismiss' },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toThrow(/admin/i);

    expect(calls.find((c) => c.service === 'messages' && c.method === 'patch')).toBeUndefined();
  });

  it('allows a dismissal that the widget authorizeDismiss permits', async () => {
    registerTestWidget(undefined, (ctx) => {
      if (ctx.submitterRole !== 'admin') {
        throw new Error('Only admins can decline this request');
      }
    });
    const fixtures = makeFixtures();
    const { app, resolutionStore } = makeApp(fixtures);

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'dismiss' },
      { user_id: 'creator-user-id' as UserID, role: 'admin' },
      {
        app: app as never,
        resolutionStore,
        runInTenantDatabaseScope,
        resolveSessionPromptAuthority: allowPrompt,
      }
    );

    expect(result.status).toBe('dismissed');
  });

  it('throws NotAuthenticated when caller is undefined', async () => {
    registerTestWidget();
    const fixtures = makeFixtures();
    const { app, resolutionStore } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'k', scope: 'global' } },
        undefined,
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toThrow(/Authentication/);
  });

  it('rejects an invalid submit body (Zod schema mismatch)', async () => {
    registerTestWidget();
    const fixtures = makeFixtures();
    const { app, resolutionStore } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { scope: 'invalid-scope' } },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toThrow(/Invalid submit/);
  });

  it('propagates applySubmit errors and durably diagnoses the claimed attempt', async () => {
    const { applySubmit } = registerTestWidget(
      vi.fn(async () => {
        throw new BadRequest('Field validation failed', {
          field_errors: { HUBSPOT_API_KEY: 'Invalid saved value selection' },
        });
      })
    );
    const fixtures = makeFixtures();
    const { app, calls, resolutionStore } = makeApp(fixtures);

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      )
    ).rejects.toMatchObject({
      data: { field_errors: { HUBSPOT_API_KEY: 'Invalid saved value selection' } },
    });

    expect(applySubmit).toHaveBeenCalledTimes(1);
    const patches = calls.filter((c) => c.service === 'messages' && c.method === 'patch');
    expect(patches).toHaveLength(2);
    const failed = patches.at(-1)?.data as {
      metadata: { widget: { status: string; resolution_failure?: { error_code: string } } };
    };
    expect(failed.metadata.widget.status).toBe('pending');
    expect(failed.metadata.widget.resolution_failure?.error_code).toBeTruthy();
    expect(JSON.stringify(failed)).not.toContain('secret-key');
    expect(calls.find((c) => c.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it('does not reopen the claim when prompt admission fails after its Task committed', async () => {
    const { applySubmit } = registerTestWidget();
    const fixtures = makeFixtures();
    const committedTaskIds: string[] = [];
    const state = makeApp(fixtures, {
      promptCreate: async (data) => {
        const taskId = (data as { idempotencyTaskId: string }).idempotencyTaskId;
        committedTaskIds.push(taskId);
        throw new Error('response lost after durable Task commit');
      },
    });
    const resolve = () =>
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        {
          app: state.app as never,
          resolutionStore: state.resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      );

    await expect(resolve()).rejects.toThrow('response lost after durable Task commit');
    expect(state.currentMessage.metadata?.widget?.status).toBe('resolving');
    expect(applySubmit).toHaveBeenCalledTimes(1);
    expect(committedTaskIds).toEqual([widgetAutoResumeTaskId('widget-msg-1' as MessageID)]);

    await expect(resolve()).rejects.toThrow(/already resolving/);
    expect(applySubmit).toHaveBeenCalledTimes(1);
    expect(
      state.calls.filter(
        (call) => call.service === '/sessions/:id/prompt' && call.method === 'create'
      )
    ).toHaveLength(1);
  });

  it('does not replay side effects when terminal completion has an unknown outcome', async () => {
    const { applySubmit } = registerTestWidget();
    const fixtures = makeFixtures();
    const state = makeApp(fixtures);
    vi.spyOn(state.resolutionStore, 'complete').mockRejectedValueOnce(
      new Error('transient completion failure')
    );
    const resolve = () =>
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        {
          app: state.app as never,
          resolutionStore: state.resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      );

    await expect(resolve()).rejects.toThrow('transient completion failure');
    expect(state.currentMessage.metadata?.widget?.status).toBe('resolving');
    expect(applySubmit).toHaveBeenCalledTimes(1);
    expect(
      state.calls.filter(
        (call) => call.service === '/sessions/:id/prompt' && call.method === 'create'
      )
    ).toHaveLength(1);

    await expect(resolve()).rejects.toThrow(/already resolving/);
    expect(applySubmit).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent resolutions on the same widget — only one applySubmit fires', async () => {
    const { applySubmit } = registerTestWidget();
    const fixtures = makeFixtures();
    const { app, resolutionStore } = makeApp(fixtures);

    // Two callers hit submit in the same tick. The lock should let one
    // through to terminal state; the second sees `status !== 'pending'` and
    // rejects. applySubmit must only run ONCE.
    const [first, second] = await Promise.allSettled([
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'one', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
      ),
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'two', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        {
          app: app as never,
          resolutionStore,
          runInTenantDatabaseScope,
          resolveSessionPromptAuthority: allowPrompt,
        }
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

/**
 * A widget type resolved by an OAuth callback rather than a submit body.
 *
 * Registered under `env_vars` so it can reuse `makeFixtures()`; the type name
 * is irrelevant to what these tests check, which is the dispatch.
 */
function registerOAuthTestWidget(
  resolveFromDaemonVerification = vi.fn(
    async (_ctx: unknown, _evidence: unknown, _params: unknown) => ({
      mcp_server_id: 'srv-1',
      name: 'Notion',
      oauth_mode: 'per_user' as const,
      attached: true,
    })
  ),
  authorizeResolve?: (ctx: unknown, params: unknown) => void | Promise<void>,
  recovery: 'none' | 'reclaimable' = 'reclaimable'
) {
  const entry: WidgetRegistryEntry<
    { names: string[]; reason: string },
    never,
    { mcp_server_id: string; name: string; oauth_mode: 'per_user'; attached: boolean }
  > = {
    type: 'env_vars',
    resolution: 'daemon_verified',
    recovery,
    schemaVersion: 1,
    paramsSchema: z.object({ names: z.array(z.string()), reason: z.string() }),
    resolveFromDaemonVerification,
    buildAutoResumePrompt: (rm) => `[Agor] User connected "${rm.name}" (attached: ${rm.attached}).`,
    buildDismissedPrompt: () => `[Agor] User declined to connect.`,
    ...(authorizeResolve ? { authorizeResolve: authorizeResolve as never } : {}),
  };
  registerWidget(entry);
  return { entry, resolveFromDaemonVerification };
}

describe('resolveWidget — OAuth resolution lane', () => {
  beforeEach(() => {
    _resetWidgetRegistryForTests();
  });

  const deps = (app: unknown, resolutionStore: unknown) => ({
    app: app as never,
    resolutionStore: resolutionStore as never,
    runInTenantDatabaseScope,
    resolveSessionPromptAuthority: allowPrompt,
  });

  it('dispatches to resolveFromDaemonVerification and reuses the shared post-resolution machinery', async () => {
    const fixtures = makeFixtures();
    const harness = makeApp(fixtures);
    const { app, calls, events, resolutionStore } = harness;
    const { resolveFromDaemonVerification } = registerOAuthTestWidget();

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'oauth_callback', evidence: { attempt_id: 'att-9' } },
      { user_id: 'creator-user-id' as UserID },
      deps(app, resolutionStore)
    );

    // The advisory attempt id reaches the handler; the widget params do too.
    expect(resolveFromDaemonVerification).toHaveBeenCalledWith(
      expect.objectContaining({ submitterUserId: 'creator-user-id' }),
      { attempt_id: 'att-9' },
      { names: ['HUBSPOT_API_KEY'], reason: 'call Hubspot' }
    );

    // Same terminal status, same durable result_meta, same auto-resume task,
    // same broadcast — none of it duplicated for this lane.
    expect(result).toMatchObject({ status: 'submitted', auto_resume_queued: true });
    expect(harness.currentMessage.metadata?.widget?.status).toBe('submitted');
    expect(harness.currentMessage.metadata?.widget?.result_meta).toMatchObject({ attached: true });
    const prompt = calls.find((call) => call.service === '/sessions/:id/prompt');
    const promptData = prompt?.data as { prompt: string; idempotencyTaskId: string } | undefined;
    expect(promptData?.prompt).toContain('Notion');
    expect(promptData?.idempotencyTaskId).toBe(widgetAutoResumeTaskId('widget-msg-1' as MessageID));
    expect(events.map((e) => e.event)).toContain('widget:resolved');
  });

  it('records the claim as an oauth_callback so a recovery reader knows which lane was in flight', async () => {
    const fixtures = makeFixtures();
    const claimed: string[] = [];
    const { app, resolutionStore } = makeApp(fixtures);
    const originalClaim = resolutionStore.claim.bind(resolutionStore);
    resolutionStore.claim = (async (id: never, input: { action: string }) => {
      claimed.push(input.action);
      return originalClaim(id, input as never);
    }) as typeof resolutionStore.claim;
    registerOAuthTestWidget();

    await resolveWidget(
      'widget-msg-1',
      { kind: 'oauth_callback', evidence: {} },
      { user_id: 'creator-user-id' as UserID },
      deps(app, resolutionStore)
    );
    expect(claimed).toEqual(['oauth_callback']);
  });

  it('refuses a submit-resolved widget reached through the OAuth endpoint', async () => {
    const fixtures = makeFixtures();
    const harness = makeApp(fixtures);
    const { app, resolutionStore } = harness;
    const { applySubmit } = registerTestWidget();

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'oauth_callback', evidence: {} },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
      // Otherwise the submit payload validation would be skipped entirely.
    ).rejects.toThrow(/resolved by 'submit'/);
    expect(applySubmit).not.toHaveBeenCalled();
    expect(harness.currentMessage.metadata?.widget?.status).toBe('pending');
  });

  it('refuses an OAuth-resolved widget reached through the submit endpoint', async () => {
    const fixtures = makeFixtures();
    const harness = makeApp(fixtures);
    const { app, resolutionStore } = harness;
    const { resolveFromDaemonVerification } = registerOAuthTestWidget();

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { connected: true } },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
      // Otherwise a client could resolve an OAuth widget by asserting success.
    ).rejects.toThrow(/resolved by 'daemon_verified'/);
    expect(resolveFromDaemonVerification).not.toHaveBeenCalled();
    expect(harness.currentMessage.metadata?.widget?.status).toBe('pending');
  });

  it('reopens the widget for a retry when the grant check refuses', async () => {
    const fixtures = makeFixtures();
    const harness = makeApp(fixtures);
    const { app, calls, resolutionStore } = harness;
    registerOAuthTestWidget(
      vi.fn(async () => {
        throw new BadRequest('Sign-in has not completed');
      }) as never
    );

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'oauth_callback', evidence: {} },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
    ).rejects.toThrow(/has not completed/);

    // Back to pending with a secret-free diagnosis, and nothing queued.
    expect(harness.currentMessage.metadata?.widget?.status).toBe('pending');
    expect(harness.currentMessage.metadata?.widget?.resolution_failure).toBeDefined();
    expect(calls.find((call) => call.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it("runs the widget type's resolve gate BEFORE claiming, and leaves the row pending", async () => {
    // A pending widget never expires, so a mint-time precondition can be false
    // by the time the button is pressed. The gate runs ahead of the claim so a
    // refusal costs nothing to unwind: no claim to release, no handler side
    // effect to have happened, no `resolution_failure` to explain away.
    const fixtures = makeFixtures();
    const harness = makeApp(fixtures);
    const { app, calls, resolutionStore } = harness;
    const claimSpy = vi.spyOn(resolutionStore, 'claim');
    const { resolveFromDaemonVerification } = registerOAuthTestWidget(undefined, () => {
      throw new Forbidden('This channel no longer aligns platform users');
    });

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'oauth_callback', evidence: {} },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
    ).rejects.toThrow(/no longer aligns/);

    expect(claimSpy).not.toHaveBeenCalled();
    expect(resolveFromDaemonVerification).not.toHaveBeenCalled();
    expect(harness.currentMessage.metadata?.widget?.status).toBe('pending');
    expect(harness.currentMessage.metadata?.widget?.resolution_failure).toBeUndefined();
    expect(calls.find((call) => call.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it('runs the resolve gate on the submit lane too', async () => {
    const fixtures = makeFixtures();
    const harness = makeApp(fixtures);
    const { app, resolutionStore } = harness;
    const gate = vi.fn(() => {
      throw new Forbidden('no longer permitted');
    });
    const entry = registerTestWidget().entry;
    _resetWidgetRegistryForTests();
    registerWidget({ ...entry, authorizeResolve: gate as never });

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'x', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
    ).rejects.toThrow(/no longer permitted/);
    expect(gate).toHaveBeenCalled();
    expect(harness.currentMessage.metadata?.widget?.status).toBe('pending');
  });

  it('still dismisses through the shared dismiss path', async () => {
    const fixtures = makeFixtures();
    const harness = makeApp(fixtures);
    const { app, calls, resolutionStore } = harness;
    registerOAuthTestWidget();

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'dismiss' },
      { user_id: 'creator-user-id' as UserID },
      deps(app, resolutionStore)
    );
    expect(result.status).toBe('dismissed');
    expect(harness.currentMessage.metadata?.widget?.status).toBe('dismissed');
    const prompt = calls.find((call) => call.service === '/sessions/:id/prompt');
    expect((prompt?.data as { prompt?: string } | undefined)?.prompt).toContain(
      'declined to connect'
    );
  });
});

/**
 * B1 — finishing a resolution the browser that started it never finished.
 *
 * The provider callback completes one milestone (the grant is persisted); the
 * widget's own resolution and the auto-resume both wait on a browser coming
 * back to POST. These cases are the durable half of what makes closing that
 * page recoverable: a `reclaimable` lane may take over an abandoned claim and
 * may answer an already-finished resolution with success rather than a
 * refusal, while every other lane keeps exactly the semantics it had.
 */
describe('resolveWidget — interrupted OAuth resolutions', () => {
  beforeEach(() => {
    _resetWidgetRegistryForTests();
  });

  const deps = (app: unknown, resolutionStore: unknown) => ({
    app: app as never,
    resolutionStore: resolutionStore as never,
    runInTenantDatabaseScope,
    resolveSessionPromptAuthority: allowPrompt,
  });

  const abandonedClaim = (ageMs: number) => ({
    token: 'claim-from-a-dead-browser',
    action: 'oauth_callback' as const,
    claimed_at: new Date(Date.now() - ageMs).toISOString(),
    claimed_by: 'creator-user-id' as UserID,
  });

  it('finishes a claim the original browser abandoned', async () => {
    const fixtures = makeFixtures({
      widgetStatus: 'resolving',
      resolutionClaim: abandonedClaim(10 * 60_000),
    });
    const harness = makeApp(fixtures);
    const { app, calls, resolutionStore } = harness;
    const { resolveFromDaemonVerification } = registerOAuthTestWidget();

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'oauth_callback', evidence: {} },
      { user_id: 'creator-user-id' as UserID },
      deps(app, resolutionStore)
    );

    expect(resolveFromDaemonVerification).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'submitted', auto_resume_queued: true });
    expect(result.already_resolved).toBeUndefined();
    expect(harness.currentMessage.metadata?.widget?.status).toBe('submitted');
    // The auto-resume is keyed by the widget, so a reclaim converges on the
    // same Task rather than waking the agent twice.
    const prompt = calls.find((call) => call.service === '/sessions/:id/prompt');
    expect((prompt?.data as { idempotencyTaskId?: string } | undefined)?.idempotencyTaskId).toBe(
      widgetAutoResumeTaskId('widget-msg-1' as MessageID)
    );
  });

  it('refuses to steal a claim that is still live', async () => {
    const fixtures = makeFixtures({
      widgetStatus: 'resolving',
      resolutionClaim: abandonedClaim(5_000),
    });
    const harness = makeApp(fixtures);
    const { app, resolutionStore } = harness;
    const { resolveFromDaemonVerification } = registerOAuthTestWidget();

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'oauth_callback', evidence: {} },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
    ).rejects.toThrow(/already resolving/);
    expect(resolveFromDaemonVerification).not.toHaveBeenCalled();
    expect(harness.currentMessage.metadata?.widget?.resolution_claim?.token).toBe(
      'claim-from-a-dead-browser'
    );
  });

  it('answers an already-finished resolution with success, not a refusal', async () => {
    const fixtures = makeFixtures({ widgetStatus: 'submitted' });
    const harness = makeApp(fixtures);
    const { app, calls, resolutionStore } = harness;
    const { resolveFromDaemonVerification } = registerOAuthTestWidget();

    const result = await resolveWidget(
      'widget-msg-1',
      { kind: 'oauth_callback', evidence: {} },
      { user_id: 'creator-user-id' as UserID },
      deps(app, resolutionStore)
    );

    expect(result).toEqual({
      widget_id: 'widget-msg-1',
      status: 'submitted',
      auto_resume_queued: false,
      already_resolved: true,
    });
    expect(resolveFromDaemonVerification).not.toHaveBeenCalled();
    expect(calls.find((call) => call.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it('keeps the conservative policy for a daemon-verified lane that did not opt in', async () => {
    const fixtures = makeFixtures({
      widgetStatus: 'resolving',
      resolutionClaim: abandonedClaim(10 * 60_000),
    });
    const harness = makeApp(fixtures);
    const { app, resolutionStore } = harness;
    const { resolveFromDaemonVerification } = registerOAuthTestWidget(undefined, undefined, 'none');

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'oauth_callback', evidence: {} },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
    ).rejects.toThrow(/already resolving/);
    expect(resolveFromDaemonVerification).not.toHaveBeenCalled();
  });

  it('keeps the conservative policy for the submit-backed widgets', async () => {
    const fixtures = makeFixtures({
      widgetStatus: 'resolving',
      resolutionClaim: { ...abandonedClaim(10 * 60_000), action: 'submit' },
    });
    const harness = makeApp(fixtures);
    const { app, resolutionStore } = harness;
    const { applySubmit } = registerTestWidget();

    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
    ).rejects.toThrow(/already resolving/);
    expect(applySubmit).not.toHaveBeenCalled();

    // …and a second submit of an already-submitted widget is still a refusal,
    // not an idempotent success: a submit body carries an external effect.
    const submitted = makeApp(makeFixtures({ widgetStatus: 'submitted' }));
    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'submit', body: { value: 'secret-key', scope: 'global' } },
        { user_id: 'creator-user-id' as UserID },
        deps(submitted.app, submitted.resolutionStore)
      )
    ).rejects.toThrow(/already submitted/);
  });

  it('will not finish a widget whose abandoned claim was a dismissal', async () => {
    const fixtures = makeFixtures({
      widgetStatus: 'resolving',
      resolutionClaim: { ...abandonedClaim(10 * 60_000), action: 'dismiss' as const },
    });
    const harness = makeApp(fixtures);
    const { app, resolutionStore } = harness;
    registerOAuthTestWidget();

    // The mirror of the case below, and the half the Slack card has to agree
    // with: "Not now" was tapped, the resolver died holding that claim, and
    // sixty seconds later the claim is old enough to take over — but only by
    // another dismissal. An `oauth_callback` is a different decision and is
    // refused by name, which is why `mcpSlackConnectRenderedState` reads the
    // claim's action and not only its age.
    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'oauth_callback', evidence: {} },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
    ).rejects.toThrow(/already resolving/);
  });

  it('will not dismiss a widget whose OAuth resolution is in flight', async () => {
    const fixtures = makeFixtures({
      widgetStatus: 'resolving',
      resolutionClaim: abandonedClaim(10 * 60_000),
    });
    const harness = makeApp(fixtures);
    const { app, resolutionStore } = harness;
    registerOAuthTestWidget();

    // The reclaim is per-action: a dismissal is a different decision from the
    // one the abandoned claim was making, and must not inherit its lease.
    await expect(
      resolveWidget(
        'widget-msg-1',
        { kind: 'dismiss' },
        { user_id: 'creator-user-id' as UserID },
        deps(app, resolutionStore)
      )
    ).rejects.toThrow(/already resolving/);
  });
});
