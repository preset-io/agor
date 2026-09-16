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

vi.mock('../../services/mcp-oauth-grant-liveness.js', () => ({
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
  };
}

function resolve(ctx: ReturnType<typeof makeCtx>['ctx'], params = defaultParams) {
  if (oauthWidget.resolution !== 'oauth_callback') throw new Error('wrong resolution kind');
  return oauthWidget.resolveFromOAuthCallback(ctx, { attempt_id: 'att-1' }, params);
}

beforeEach(() => {
  livenessStub.mockReset();
  livenessStub.mockResolvedValue({ live: true });
});

describe('oauth widget — registry registration', () => {
  beforeEach(() => _resetWidgetRegistryForTests());

  it('registers under the oauth type as an OAuth-callback-resolved widget', () => {
    registerOAuthWidget();
    const entry = getWidget('oauth');
    expect(entry?.type).toBe('oauth');
    expect(entry?.schemaVersion).toBe(1);
    expect(entry?.resolution).toBe('oauth_callback');
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

describe('oauth widget — resolveFromOAuthCallback', () => {
  it('refuses, and does NOT attach, when no live grant exists', async () => {
    livenessStub.mockResolvedValue({ live: false });
    const { ctx, attachSpy } = makeCtx();

    await expect(resolve(ctx)).rejects.toThrow(/has not completed/i);
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
    const { ctx } = makeCtx({ attachError: new Forbidden('Only the session owner') });
    const meta = await resolve(ctx);

    // The grant is real; only the attach was refused. Failing outright would
    // reopen the widget and ask the user to repeat a flow that worked.
    expect(meta.attached).toBe(false);
  });

  it('propagates a non-authorization attach failure so the widget reopens', async () => {
    const { ctx } = makeCtx({ attachError: new Error('database is down') });
    await expect(resolve(ctx)).rejects.toThrow(/database is down/);
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
    livenessStub.mockResolvedValue({ live: true, expiresAt: new Date('2030-01-01') });
    const meta = await resolve(ctx);

    const serialized = JSON.stringify(meta);
    expect(Object.keys(meta).sort()).toEqual(['attached', 'mcp_server_id', 'name', 'oauth_mode']);
    expect(serialized).not.toMatch(/token|expires|scope|secret|2030/i);
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
