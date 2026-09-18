/**
 * `oauth` widget — daemon-side tests.
 *
 * Mirrors `widgets/gateway-token/index.test.ts`: pure-ish over a stubbed `app`
 * surface, no FeathersJS bootstrap. The properties under test are the ones
 * that make this widget safe to expose to an agent:
 *
 *   - resolution is grant-verified, not client-asserted: no live grant means
 *     no resolution and NO attach
 *   - the attach happens only after the grant check passes
 *   - the pinned `mcpServerId` is the only destination; a server that was
 *     disabled, converted away from OAuth, or switched modes is refused
 *   - shared mode is admin-only on the resolve path too, not just at mint
 *   - `result_meta` and both prompts carry names only — never a token,
 *     expiry, or scope
 */

import type { UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the database read is stubbed; `mcpOAuthGrantIsConnected` — the verdict
// this gate asks of it, shared with the mint gate — stays real.
vi.mock('../../services/mcp-oauth-grant-liveness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mcp-oauth-grant-liveness.js')>()),
  resolveMCPOAuthGrantLiveness: vi.fn(),
}));

import { Forbidden } from '@agor/core/feathers';
import { resolveMCPOAuthGrantLiveness } from '../../services/mcp-oauth-grant-liveness.js';
import { _resetWidgetRegistryForTests, getWidget } from '../registry';
import {
  assertOAuthWidgetRoleFloor,
  oauthParamsSchema,
  oauthWidget,
  registerOAuthWidget,
} from './index';

const livenessStub = resolveMCPOAuthGrantLiveness as unknown as ReturnType<typeof vi.fn>;

const defaultParams = {
  mcpServerId: 'srv-notion',
  serverName: 'Notion',
  oauthMode: 'per_user' as const,
  reason: 'Read the roadmap page.',
  catalogEntryName: 'com.notion/mcp',
  permissionDisclosure: 'Agor can read and write pages you share with this integration.',
};

interface MakeCtxOpts {
  submitterRole?: string | undefined;
  server?: Record<string, unknown> | null;
  attachError?: unknown;
  /** Session owner. Defaults to the resolver, i.e. the attach is allowed. */
  sessionCreator?: string;
  /** `custom_context` on the host session — set `gateway_source` for the guard. */
  customContext?: Record<string, unknown>;
  gatewayChannel?: { channel_type: string; config: Record<string, unknown> };
}

/** The default row the pinned server resolves to. */
const OAUTH_SERVER_ROW = () => ({
  mcp_server_id: 'srv-notion',
  name: 'notion',
  display_name: 'Notion',
  enabled: true,
  scope: 'session',
  owner_user_id: 'user-actor',
  auth: { type: 'oauth', oauth_mode: 'per_user' },
});

function makeCtx(opts: MakeCtxOpts = {}) {
  const server = opts.server === undefined ? OAUTH_SERVER_ROW() : opts.server;
  const attachSpy = vi.fn(async () => {
    if (opts.attachError) throw opts.attachError;
    return {};
  });
  const channelSpy = vi.fn(async () =>
    opts.gatewayChannel ? { id: 'chan-1', name: 'eng-help', ...opts.gatewayChannel } : undefined
  );
  const app = {
    get: (key: string) => (key === 'database' ? ({} as never) : undefined),
    service(name: string) {
      if (name === 'mcp-servers') {
        return {
          get: vi.fn(async () => {
            if (!server) throw new Error('MCP server not found');
            return server;
          }),
        };
      }
      if (name === 'sessions') {
        return {
          get: vi.fn(async () => ({
            session_id: 'sess-1',
            branch_id: 'wt-1',
            created_by: opts.sessionCreator ?? 'user-actor',
            ...(opts.customContext ? { custom_context: opts.customContext } : {}),
          })),
        };
      }
      if (name === 'gateway-channels') return { get: channelSpy };
      if (name === '/sessions/:id/mcp-servers') return { create: attachSpy };
      throw new Error(`Unexpected service call: ${name}`);
    },
  };
  return {
    ctx: {
      app: app as never,
      sessionId: 'sess-1' as never,
      submitterUserId: 'user-actor' as UserID,
      submitterRole: 'submitterRole' in opts ? opts.submitterRole : 'member',
      sessionCreatorUserId: 'user-actor' as UserID,
      runInTenantDatabaseScope: <T>(work: () => Promise<T>) => work(),
    },
    attachSpy,
    channelSpy,
  };
}

function resolve(ctx: ReturnType<typeof makeCtx>['ctx'], params = defaultParams) {
  if (oauthWidget.resolution !== 'daemon_verified') throw new Error('wrong resolution kind');
  return oauthWidget.resolveFromDaemonVerification(ctx, { attempt_id: 'att-1' }, params);
}

beforeEach(() => {
  livenessStub.mockReset();
  livenessStub.mockResolvedValue({ live: true, reason: 'live', refreshable: false });
});

describe('oauth widget — registry registration', () => {
  beforeEach(() => _resetWidgetRegistryForTests());

  it('registers under the oauth type as an OAuth-callback-resolved widget', () => {
    registerOAuthWidget();
    const entry = getWidget('oauth');
    expect(entry?.type).toBe('oauth');
    expect(entry?.schemaVersion).toBe(1);
    expect(entry?.resolution).toBe('daemon_verified');
  });

  it('exposes no submit path — a form body can never resolve it', () => {
    registerOAuthWidget();
    const entry = getWidget('oauth');
    expect(entry && 'applySubmit' in entry).toBe(false);
    expect(entry && 'submitSchema' in entry).toBe(false);
  });

  it('is idempotent — repeated calls do not throw', () => {
    registerOAuthWidget();
    expect(() => registerOAuthWidget()).not.toThrow();
  });
});

describe('oauth widget — paramsSchema', () => {
  it('accepts the non-secret params', () => {
    expect(oauthParamsSchema.safeParse(defaultParams).success).toBe(true);
  });

  it('rejects unknown keys, so no field can be smuggled onto the widget row', () => {
    const result = oauthParamsSchema.safeParse({
      ...defaultParams,
      oauth_access_token: 'secret',
    });
    expect(result.success).toBe(false);
  });

  it('requires a pinned server id and a known oauth mode', () => {
    expect(oauthParamsSchema.safeParse({ ...defaultParams, mcpServerId: '' }).success).toBe(false);
    expect(oauthParamsSchema.safeParse({ ...defaultParams, oauthMode: 'team' }).success).toBe(
      false
    );
  });
});

describe('oauth widget — role floor', () => {
  it('allows a member (or unknown role) to connect a per-user server', () => {
    expect(() => assertOAuthWidgetRoleFloor('member', 'per_user')).not.toThrow();
    expect(() => assertOAuthWidgetRoleFloor(undefined, 'per_user')).not.toThrow();
  });

  it('requires admin for a shared, workspace-wide grant', () => {
    expect(() => assertOAuthWidgetRoleFloor('member', 'shared')).toThrow(Forbidden);
    // Undefined normalizes to member, so it must fail closed.
    expect(() => assertOAuthWidgetRoleFloor(undefined, 'shared')).toThrow(Forbidden);
    expect(() => assertOAuthWidgetRoleFloor('admin', 'shared')).not.toThrow();
  });

  it('gates the resolve path, not only the mint path', async () => {
    const { ctx, attachSpy } = makeCtx({
      submitterRole: 'member',
      server: {
        mcp_server_id: 'srv-notion',
        name: 'notion',
        enabled: true,
        auth: { type: 'oauth', oauth_mode: 'shared' },
      },
    });
    await expect(resolve(ctx, { ...defaultParams, oauthMode: 'shared' })).rejects.toThrow(/admin/i);
    expect(attachSpy).not.toHaveBeenCalled();
  });
});

describe('oauth widget — resolveFromDaemonVerification', () => {
  it('refuses, and does NOT attach, when no grant exists', async () => {
    livenessStub.mockResolvedValue({ live: false, reason: 'no_grant', refreshable: false });
    const { ctx, attachSpy } = makeCtx();

    await expect(resolve(ctx)).rejects.toThrow(/has not completed/i);
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it('refuses an expired grant with nothing left to refresh with', async () => {
    // The other side of the widening below: `expired` is not by itself a
    // finish. Without a spendable refresh token the next turn has no
    // credential, and this user really does have to sign in again.
    livenessStub.mockResolvedValue({ live: false, reason: 'expired', refreshable: false });
    const { ctx, attachSpy } = makeCtx();

    await expect(resolve(ctx)).rejects.toThrow(/has not completed/i);
    expect(attachSpy).not.toHaveBeenCalled();
  });

  /**
   * D4.1: the gate asks the same verdict the mint gate asks.
   *
   * This is the B1 user, one hour later. Their sign-in landed, the page went
   * away before the POST, and by the time they press *Finish connecting* the
   * access token that sign-in produced has lapsed — leaving a bound grant with
   * a refresh token the inject hook will spend before the executor sees it.
   *
   * Requiring `live` here refused them, with copy telling them to go and
   * complete a sign-in they had already completed — while the mint gate would
   * have attached and resumed for the very same grant, for free. Nothing is
   * issued or sealed by resolving: the credential exists, and this attaches its
   * server to the session and wakes the agent.
   */
  it('finishes for a grant whose access token lapsed while the user was away', async () => {
    livenessStub.mockResolvedValue({ live: false, reason: 'expired', refreshable: true });
    const { ctx, attachSpy } = makeCtx();

    const meta = await resolve(ctx);
    expect(meta.attached).toBe(true);
    expect(attachSpy).toHaveBeenCalled();
    // Straight through: no settle wait, because there is no race to settle.
    expect(livenessStub).toHaveBeenCalledTimes(1);
  });

  /**
   * The daemon's JIT refresh can be in flight at exactly the moment the
   * browser POSTs: the callback persisted the grant and the inject hook is
   * already spending it. A `refreshing` row with a spendable refresh token now
   * counts on the first read; this is the narrower remainder — `ambiguous`, or
   * nothing left to refresh with — where nobody knows the outcome yet, so the
   * gate still refuses, but the user on the other end just finished signing in
   * and "finish the provider sign-in" would be both false and an instruction
   * to redo a flow that worked. One short look turns the race into a success.
   */
  it('re-reads once when a refresh of unknown outcome is in flight, and resolves if it settles', async () => {
    livenessStub
      .mockResolvedValueOnce({ live: false, reason: 'refreshing', refreshable: false })
      .mockResolvedValueOnce({ live: true, reason: 'live', refreshable: false });
    const { ctx, attachSpy } = makeCtx();

    const meta = await resolve(ctx);
    expect(livenessStub).toHaveBeenCalledTimes(2);
    expect(meta.attached).toBe(true);
    expect(attachSpy).toHaveBeenCalled();
  });

  it('tells a still-refreshing user to wait, not to sign in again', async () => {
    livenessStub.mockResolvedValue({ live: false, reason: 'refreshing', refreshable: false });
    const { ctx, attachSpy } = makeCtx();

    const error = await resolve(ctx).then(
      () => null,
      (err: Error) => err
    );
    expect(error?.message).toMatch(/still finishing/i);
    expect(error?.message).not.toMatch(/Finish the provider sign-in/i);
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it('looks the grant up under the RESOLVER, not the session owner', async () => {
    const { ctx } = makeCtx();
    ctx.sessionCreatorUserId = 'user-session-owner' as UserID;
    await resolve(ctx);

    expect(livenessStub).toHaveBeenCalledWith(expect.anything(), 'srv-notion', 'user-actor');
  });

  it('attaches only after the grant check passes, and reports it', async () => {
    const { ctx, attachSpy } = makeCtx();
    const meta = await resolve(ctx);

    expect(attachSpy).toHaveBeenCalledWith(
      { mcpServerId: 'srv-notion' },
      expect.objectContaining({ route: { id: 'sess-1' } })
    );
    expect(meta).toEqual({
      mcp_server_id: 'srv-notion',
      name: 'Notion',
      oauth_mode: 'per_user',
      attached: true,
    });
  });

  it('degrades to attached:false when the resolver may not configure the session', async () => {
    // The resolver is a shared-session collaborator, not the owner: the grant
    // is real, only somebody else's permission is missing. Failing outright
    // would reopen the widget and ask the user to repeat a flow that worked.
    const { ctx, attachSpy } = makeCtx({ sessionCreator: 'user-session-owner' });
    const meta = await resolve(ctx);

    expect(meta.attached).toBe(false);
    // Decided by ASKING, before the attach — not by classifying its exception.
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it('propagates a non-authorization attach failure so the widget reopens', async () => {
    const { ctx } = makeCtx({ attachError: new Error('database is down') });
    await expect(resolve(ctx)).rejects.toThrow(/database is down/);
  });

  it('does NOT report attached:false for a Forbidden it did not reason about', async () => {
    // `MCPServerNotUsableError` maps to Forbidden('That MCP server is private
    // to another user') at `register-routes.ts`. Swallowing it produced a card
    // and an auto-resume prompt telling the agent to ask the session owner to
    // attach — but the session owner cannot attach a server private to a third
    // user either, so the agent looped on something impossible. Tenant
    // write-gate and member-policy refusals had the same wrong advice.
    const { ctx } = makeCtx({
      attachError: new Forbidden('That MCP server is private to another user'),
    });
    await expect(resolve(ctx)).rejects.toThrow(/private to another user/);
  });

  it('refuses a resolver who does not own the pinned server', async () => {
    // The resolver need not be the actor who minted the widget — a shared
    // session lets a collaborator reach the resolve endpoint. Regression: the
    // params-shaped `isMcpServerUsableByCaller` classifies a provider-less
    // daemon-side call as INTERNAL and returns true unconditionally, so this
    // check has to use the pure ownership predicate or it silently passes.
    const { ctx, attachSpy } = makeCtx({
      server: { ...OAUTH_SERVER_ROW(), owner_user_id: 'someone-else' },
    });
    await expect(resolve(ctx)).rejects.toThrow(/not available to you/i);
    expect(attachSpy).not.toHaveBeenCalled();
    expect(livenessStub).not.toHaveBeenCalled();
  });

  it('lets an admin resolve a server owned by someone else', async () => {
    const { ctx } = makeCtx({
      submitterRole: 'admin',
      server: { ...OAUTH_SERVER_ROW(), owner_user_id: 'someone-else' },
    });
    await expect(resolve(ctx)).resolves.toMatchObject({ attached: true });
  });

  it('refuses a server that was disabled between mint and resolve', async () => {
    const { ctx, attachSpy } = makeCtx({
      server: {
        mcp_server_id: 'srv-notion',
        name: 'notion',
        enabled: false,
        auth: { type: 'oauth', oauth_mode: 'per_user' },
      },
    });
    await expect(resolve(ctx)).rejects.toThrow(/no longer an enabled OAuth/i);
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it('refuses a server converted away from OAuth', async () => {
    const { ctx } = makeCtx({
      server: {
        mcp_server_id: 'srv-notion',
        name: 'notion',
        enabled: true,
        auth: { type: 'bearer', token: 'nope' },
      },
    });
    await expect(resolve(ctx)).rejects.toThrow(/no longer an enabled OAuth/i);
  });

  it('refuses when the server switched OAuth mode since the widget was minted', async () => {
    const { ctx } = makeCtx({
      submitterRole: 'admin',
      server: {
        mcp_server_id: 'srv-notion',
        name: 'notion',
        enabled: true,
        auth: { type: 'oauth', oauth_mode: 'shared' },
      },
    });
    await expect(resolve(ctx)).rejects.toThrow(/changed OAuth mode/i);
  });

  it('fails closed when the database handle is unavailable', async () => {
    const { ctx, attachSpy } = makeCtx();
    (ctx.app as unknown as { get: (k: string) => unknown }).get = () => undefined;
    await expect(resolve(ctx)).rejects.toThrow(/unavailable/i);
    expect(attachSpy).not.toHaveBeenCalled();
    expect(livenessStub).not.toHaveBeenCalled();
  });

  it('never puts credential material in result_meta', async () => {
    const { ctx } = makeCtx();
    livenessStub.mockResolvedValue({
      live: true,
      reason: 'live',
      refreshable: false,
      expiresAt: new Date('2030-01-01'),
    });
    const meta = await resolve(ctx);

    const serialized = JSON.stringify(meta);
    expect(Object.keys(meta).sort()).toEqual(['attached', 'mcp_server_id', 'name', 'oauth_mode']);
    expect(serialized).not.toMatch(/token|expires|scope|secret|2030/i);
  });
});

describe('oauth widget — authorizeResolve (the mint-time questions, re-asked)', () => {
  const gatewaySession = {
    gateway_source: {
      channel_id: 'chan-1',
      channel_name: 'eng-help',
      channel_type: 'slack',
      thread_id: 't1',
    },
  };

  const authorizeResolve = (ctx: ReturnType<typeof makeCtx>['ctx'], params = defaultParams) => {
    const entry = getWidget('oauth');
    if (!entry?.authorizeResolve) throw new Error('oauth widget declares no resolve gate');
    return entry.authorizeResolve(ctx, params);
  };

  beforeEach(() => {
    _resetWidgetRegistryForTests();
    registerOAuthWidget();
  });

  it('passes for an ordinary non-gateway session', async () => {
    const { ctx } = makeCtx();
    await expect(authorizeResolve(ctx)).resolves.toBeUndefined();
  });

  it('refuses when alignment was switched OFF after the widget was minted', async () => {
    // The window here is unbounded: a pending card never expires, so "aligned
    // when minted" is not evidence of "aligned now". Resolving anyway would
    // persist the grant under the channel's shared "Post messages as" account
    // — exactly what the mint gate refused.
    const { ctx } = makeCtx({
      customContext: gatewaySession,
      gatewayChannel: { channel_type: 'slack', config: { align_slack_users: false } },
    });
    await expect(authorizeResolve(ctx)).rejects.toThrow(/align_slack_users/);
  });

  it('passes while the channel is still aligned', async () => {
    const { ctx } = makeCtx({
      customContext: gatewaySession,
      gatewayChannel: { channel_type: 'slack', config: { align_slack_users: true } },
    });
    await expect(authorizeResolve(ctx)).resolves.toBeUndefined();
  });

  it('re-asks the role floor too, for a resolver demoted since mint', async () => {
    const { ctx } = makeCtx({ submitterRole: 'member' });
    await expect(authorizeResolve(ctx, { ...defaultParams, oauthMode: 'shared' })).rejects.toThrow(
      /admin/i
    );
  });
});

describe('oauth widget — authorizeMint', () => {
  const mintCtx = (app: unknown, role = 'member') => ({
    app: app as never,
    sessionId: 'sess-1' as never,
    userId: 'user-actor' as UserID,
    role,
    serviceParams: { user: { user_id: 'user-actor', role } },
  });

  beforeEach(() => {
    _resetWidgetRegistryForTests();
    registerOAuthWidget();
  });

  const authorizeMint = (app: unknown, role?: string, params?: typeof defaultParams) => {
    const entry = getWidget('oauth');
    if (!entry?.authorizeMint) throw new Error('oauth widget declares no mint gate');
    return entry.authorizeMint(mintCtx(app, role), params);
  };

  it('answers the identity question with no params, so a caller can refuse early', async () => {
    const { ctx } = makeCtx({
      customContext: {
        gateway_source: {
          channel_id: 'chan-1',
          channel_name: 'eng-help',
          channel_type: 'slack',
          thread_id: 't1',
        },
      },
      gatewayChannel: { channel_type: 'slack', config: { align_slack_users: false } },
    });
    // No params: the destination is not resolved yet, and the identity
    // question does not need one.
    await expect(authorizeMint(ctx.app)).rejects.toThrow(/align_slack_users/);
  });

  it('adds the role floor once params name the mode', async () => {
    const { ctx } = makeCtx();
    await expect(authorizeMint(ctx.app, 'member')).resolves.toBeUndefined();
    await expect(
      authorizeMint(ctx.app, 'member', { ...defaultParams, oauthMode: 'shared' })
    ).rejects.toThrow(/admin/i);
    await expect(
      authorizeMint(ctx.app, 'admin', { ...defaultParams, oauthMode: 'shared' })
    ).resolves.toBeUndefined();
  });
});

describe('oauth widget — prompts', () => {
  it('tells the agent the tools arrive on a later turn when the attach succeeded', () => {
    const prompt = oauthWidget.buildAutoResumePrompt(
      { mcp_server_id: 'srv-notion', name: 'Notion', oauth_mode: 'per_user', attached: true },
      defaultParams
    );
    expect(prompt).toContain('Notion');
    expect(prompt).toContain('next turn');
    expect(prompt).not.toMatch(/token|secret/i);
  });

  it('says what to do instead when the attach was refused', () => {
    const prompt = oauthWidget.buildAutoResumePrompt(
      { mcp_server_id: 'srv-notion', name: 'Notion', oauth_mode: 'per_user', attached: false },
      defaultParams
    );
    expect(prompt).toMatch(/session owner or an admin/i);
  });

  it('tells the agent not to immediately re-ask on dismissal', () => {
    const prompt = oauthWidget.buildDismissedPrompt(defaultParams);
    expect(prompt).toContain('Notion');
    expect(prompt).toMatch(/immediately re-ask/i);
  });
});
