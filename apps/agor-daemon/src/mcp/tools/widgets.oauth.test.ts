/**
 * `agor_widgets_request_oauth` — MCP tool handler tests.
 *
 * The tool is the mint side of the OAuth connect lane. What it must get right:
 *
 *   - exactly one destination (`mcpServerId` XOR `catalogEntryName`), so an
 *     agent can never end up naming a URL of its own
 *   - fail CLOSED on gateway identity: a Slack channel that does not align
 *     platform users runs every message as one shared account, so a sign-in
 *     started from there would mint a credential the whole channel drives
 *   - shared-mode grants are admin-only at mint, not only at resolve
 *   - the already-connected short-circuit attaches and resumes instead of
 *     rendering a button with nothing behind it
 *   - the catalog install is inert: created, NOT attached, until a grant lands
 *   - widget params carry names and identities only — no credential
 */

import type { MessageID, SessionID } from '@agor/core/types';
import { getSessionUrl } from '@agor/core/utils/url';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/append-system-message.js', () => ({
  appendSystemMessage: vi.fn(),
}));
vi.mock('../../services/mcp-oauth-grant-liveness.js', () => ({
  resolveMCPOAuthGrantLiveness: vi.fn(),
}));
/**
 * Widget rows the supersede sweep will find, and the calls it made. Reassigned
 * per test; the repository stub below reads them.
 */
const superseded = {
  rows: [] as Array<Record<string, unknown>>,
  scans: [] as Array<{ type: string; options?: { limit?: number; newestFirst?: boolean } }>,
};

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  // The supersede sweep is best-effort and its repository has no business
  // touching a real handle here; stub it so it is observable but inert.
  MessagesRepository: class {
    async findBySessionIdAndType(
      _sessionId: string,
      type: string,
      options?: { limit?: number; newestFirst?: boolean }
    ) {
      superseded.scans.push({ type, options });
      return superseded.rows;
    }
    async mutateMetadataLocked() {
      throw new Error(
        'widget lifecycle state must be written through WidgetResolutionStore, not the repository'
      );
    }
  },
}));

import { resolveMCPOAuthGrantLiveness } from '../../services/mcp-oauth-grant-liveness.js';
import { appendSystemMessage } from '../../utils/append-system-message.js';
import { registerAllWidgets } from '../../widgets/index.js';
import { _resetWidgetRegistryForTests } from '../../widgets/registry.js';
import { registerWidgetTools } from './widgets.js';

// The mint gate lives on the registry entry, so the tool is only as guarded as
// the daemon's boot registration makes it. Registering here is not scaffolding
// — it is the same call `index.ts` makes, and without it `authorizeWidgetMint`
// refuses outright rather than passing silently.
registerAllWidgets();

const livenessStub = resolveMCPOAuthGrantLiveness as unknown as ReturnType<typeof vi.fn>;
const appendStub = appendSystemMessage as unknown as ReturnType<typeof vi.fn>;

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

interface ServiceCall {
  service: string;
  method: string;
  args: unknown[];
}

const OAUTH_SERVER = {
  mcp_server_id: 'srv-notion',
  name: 'notion',
  display_name: 'Notion',
  enabled: true,
  scope: 'session',
  owner_user_id: 'user-actor',
  auth: { type: 'oauth', oauth_mode: 'per_user' },
};

const NOTION_ENTRY = {
  name: 'com.notion/mcp',
  has_remote: true,
  remote_url: 'https://mcp.notion.com/mcp',
  auth_type: 'oauth',
  category: 'productivity',
  capabilities: ['notes'],
  benefit: 'Read and write Notion pages.',
  starter_prompt: 'Summarize my roadmap page.',
  permission_disclosure: 'Agor can read and write pages you share with this integration.',
};

interface MakeAppOpts {
  /** Session `custom_context`; set `gateway_source` to exercise the guard. */
  customContext?: Record<string, unknown>;
  gatewayChannel?: { channel_type: string; config: Record<string, unknown> };
  server?: Record<string, unknown> | null;
  catalogEntry?: Record<string, unknown> | null;
  connectResult?: Record<string, unknown>;
  sessionCreator?: string;
}

function makeApp(opts: MakeAppOpts = {}) {
  const calls: ServiceCall[] = [];
  const record = (service: string, method: string, args: unknown[]) =>
    calls.push({ service, method, args });

  const services: Record<string, Record<string, (...args: unknown[]) => unknown>> = {
    sessions: {
      get: async (...args) => {
        record('sessions', 'get', args);
        return {
          session_id: 'sess-1',
          branch_id: 'wt-1',
          created_by: opts.sessionCreator ?? 'user-actor',
          ...(opts.customContext ? { custom_context: opts.customContext } : {}),
        };
      },
    },
    'gateway-channels': {
      get: async (...args) => {
        record('gateway-channels', 'get', args);
        return opts.gatewayChannel
          ? { id: 'chan-1', name: 'eng', ...opts.gatewayChannel }
          : undefined;
      },
    },
    'mcp-servers': {
      get: async (...args) => {
        record('mcp-servers', 'get', args);
        if (opts.server === null) throw new Error('MCP server not found');
        return opts.server ?? OAUTH_SERVER;
      },
    },
    'mcp-catalog': {
      get: async (...args) => {
        record('mcp-catalog', 'get', args);
        if (opts.catalogEntry === null) throw new Error('not found');
        return opts.catalogEntry ?? NOTION_ENTRY;
      },
    },
    'mcp-catalog/connect': {
      create: async (...args) => {
        record('mcp-catalog/connect', 'create', args);
        return opts.connectResult ?? { mcp_server: OAUTH_SERVER, reused_existing_server: false };
      },
    },
    '/sessions/:id/mcp-servers': {
      create: async (...args) => {
        record('/sessions/:id/mcp-servers', 'create', args);
        return {};
      },
    },
    '/sessions/:id/prompt': {
      create: async (...args) => {
        record('/sessions/:id/prompt', 'create', args);
        return { task_id: 'task-stub' };
      },
    },
    tasks: {
      find: async () => ({ data: [], total: 0, limit: 10, skip: 0 }),
      patch: async () => ({}),
    },
    users: { get: async (...args) => ({ user_id: args[0], env_vars: {} }) },
  };

  // The one writer of widget lifecycle state, as the daemon publishes it.
  const supersedeSpy = vi.fn(async () => ({ outcome: 'superseded' as const }));
  return {
    calls,
    supersedeSpy,
    app: {
      get: (key: string) =>
        key === 'widgetResolutionStore' ? { supersede: supersedeSpy } : undefined,
      service(name: string) {
        const svc = services[name];
        if (!svc) throw new Error(`Unexpected service call: ${name}`);
        return svc;
      },
    },
  };
}

function registerAndCapture(ctx: {
  app: unknown;
  userId?: string;
  sessionId?: string;
  role?: string;
}): Record<string, { cfg: { description?: string }; cb: ToolHandler }> {
  const captured: Record<string, { cfg: { description?: string }; cb: ToolHandler }> = {};
  const fakeServer = {
    registerTool: (name: string, cfg: unknown, cb: ToolHandler) => {
      captured[name] = { cfg: cfg as { description?: string }, cb };
    },
  } as unknown as McpServer;

  const userId = ctx.userId ?? 'user-actor';
  registerWidgetTools(fakeServer, {
    app: ctx.app as never,
    db: {} as never,
    userId: userId as never,
    sessionId: (ctx.sessionId ?? 'sess-1') as never,
    authenticatedUser: { user_id: userId, role: ctx.role ?? 'member' } as never,
    baseServiceParams: {
      user: { user_id: userId, role: ctx.role ?? 'member' },
      authenticated: true,
      provider: 'mcp',
    } as never,
  });
  return captured;
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  appendStub.mockReset();
  appendStub.mockImplementation(
    async (input: { messageId?: MessageID; metadata?: Record<string, unknown> }) => ({
      message_id: input.messageId ?? ('widget-1' as MessageID),
      index: 7,
      metadata: input.metadata,
    })
  );
  livenessStub.mockReset();
  livenessStub.mockResolvedValue({ live: false });
  superseded.rows = [];
  superseded.scans = [];
});

/** A still-pending oauth Connect button for `serverId`, as the sweep sees it. */
const pendingOAuthWidget = (messageId: string, serverId: string) => ({
  message_id: messageId,
  metadata: {
    widget: {
      widget_type: 'oauth',
      status: 'pending',
      params: { mcpServerId: serverId },
    },
  },
});

describe('agor_widgets_request_oauth — destination selection', () => {
  it('refuses when neither destination is named', async () => {
    const { app } = makeApp();
    const tools = registerAndCapture({ app });
    await expect(tools.agor_widgets_request_oauth.cb({ reason: 'x' })).rejects.toThrow(
      /exactly one of mcpServerId or catalogEntryName/i
    );
    expect(appendStub).not.toHaveBeenCalled();
  });

  it('refuses when both destinations are named', async () => {
    const { app } = makeApp();
    const tools = registerAndCapture({ app });
    await expect(
      tools.agor_widgets_request_oauth.cb({
        mcpServerId: 'srv-notion',
        catalogEntryName: 'com.notion/mcp',
      })
    ).rejects.toThrow(/exactly one/i);
  });

  it('refuses to mint a widget type this daemon does not speak', async () => {
    // Fail-closed backstop: an unregistered type has no gate, so minting it
    // would be minting something nothing checked.
    _resetWidgetRegistryForTests();
    try {
      const { app } = makeApp();
      const tools = registerAndCapture({ app });
      await expect(
        tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
      ).rejects.toThrow(/not registered on this daemon/i);
      expect(appendStub).not.toHaveBeenCalled();
    } finally {
      registerAllWidgets();
    }
  });

  it('mints a pending widget pinned to an existing OAuth server', async () => {
    const { app, calls } = makeApp();
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({
      mcpServerId: 'srv-notion',
      reason: 'Read the roadmap page.',
    });

    expect(payload(result)).toMatchObject({ status: 'requested' });
    const widget = appendStub.mock.calls[0][0].metadata.widget;
    expect(widget.widget_type).toBe('oauth');
    expect(widget.status).toBe('pending');
    expect(widget.params).toEqual({
      mcpServerId: 'srv-notion',
      serverName: 'Notion',
      oauthMode: 'per_user',
      reason: 'Read the roadmap page.',
    });
    // Nothing is attached while the server is unauthorized.
    expect(calls.find((c) => c.service === '/sessions/:id/mcp-servers')).toBeUndefined();
  });

  it('refuses a server that is not OAuth, naming what to use instead', async () => {
    const { app } = makeApp({
      server: { ...OAUTH_SERVER, auth: { type: 'bearer', token: 'x' } },
    });
    const tools = registerAndCapture({ app });
    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    ).rejects.toThrow(/agor_widgets_request_env_vars|MCP Catalog/);
  });

  it('refuses a server private to somebody else without confirming it exists', async () => {
    const { app } = makeApp({ server: { ...OAUTH_SERVER, owner_user_id: 'someone-else' } });
    const tools = registerAndCapture({ app });
    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    ).rejects.toThrow('MCP server not found');
  });
});

describe('agor_widgets_request_oauth — catalog install', () => {
  it('installs through mcp-catalog/connect and leaves the row unattached', async () => {
    const { app, calls } = makeApp();
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ catalogEntryName: 'com.notion/mcp' });

    const connect = calls.find((c) => c.service === 'mcp-catalog/connect');
    expect(connect?.args[0]).toEqual({
      catalog_key: 'com.notion/mcp',
      acknowledged_disclosure: NOTION_ENTRY.permission_disclosure,
    });
    // Inert: installed, never attached, until the grant lands.
    expect(calls.find((c) => c.service === '/sessions/:id/mcp-servers')).toBeUndefined();

    const widget = appendStub.mock.calls[0][0].metadata.widget;
    expect(widget.params.catalogEntryName).toBe('com.notion/mcp');
    // The disclosure travels onto the widget so the user reads it before the
    // only moment anything is actually granted.
    expect(widget.params.permissionDisclosure).toBe(NOTION_ENTRY.permission_disclosure);
  });

  it('refuses an unknown catalog name and points at the catalog tool', async () => {
    const { app } = makeApp({ catalogEntry: null });
    const tools = registerAndCapture({ app });
    await expect(
      tools.agor_widgets_request_oauth.cb({ catalogEntryName: 'com.nope/mcp' })
    ).rejects.toThrow(/agor_mcp_catalog_list/);
  });

  it('refuses an API-key entry rather than opening an OAuth flow it cannot finish', async () => {
    const { app } = makeApp({
      catalogEntry: { ...NOTION_ENTRY, auth_type: 'credentials' },
    });
    const tools = registerAndCapture({ app });
    await expect(
      tools.agor_widgets_request_oauth.cb({ catalogEntryName: 'com.notion/mcp' })
    ).rejects.toThrow(/API key/i);
  });

  it('attaches and resumes immediately when the probe found no auth at all', async () => {
    const openServer = { ...OAUTH_SERVER, auth: undefined };
    const { app, calls } = makeApp({
      catalogEntry: { ...NOTION_ENTRY, auth_type: 'none' },
      connectResult: { mcp_server: openServer, reused_existing_server: false },
    });
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({
      catalogEntryName: 'com.notion/mcp',
    });

    expect(payload(result).status).toBe('already_present');
    expect(calls.find((c) => c.service === '/sessions/:id/mcp-servers')).toBeDefined();
    expect(calls.find((c) => c.service === '/sessions/:id/prompt')).toBeDefined();
  });
});

describe('agor_widgets_request_oauth — catalog-owned fields cannot orphan an install', () => {
  it('clamps an over-long permission disclosure instead of installing then failing', async () => {
    // The install is the first durable effect. A disclosure longer than
    // `oauthParamsSchema`'s 1000 used to leave an installed server row behind
    // and then throw out of the tool. The longest entry in today's curated.yaml
    // is 808 chars, so this is a curation slip away.
    const { app, calls } = makeApp({
      catalogEntry: { ...NOTION_ENTRY, permission_disclosure: 'x'.repeat(1400) },
    });
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({
      catalogEntryName: 'com.notion/mcp',
    });

    expect(payload(result).status).toBe('requested');
    const disclosure = appendStub.mock.calls[0][0].metadata.widget.params.permissionDisclosure;
    expect(disclosure).toHaveLength(1000);
    expect(disclosure.endsWith('…')).toBe(true);
    // The install still ran, and it acknowledged the entry's REAL text.
    const connect = calls.find((c) => c.service === 'mcp-catalog/connect');
    const connectArgs = connect?.args[0] as { acknowledged_disclosure: string } | undefined;
    expect(connectArgs?.acknowledged_disclosure).toBe('x'.repeat(1400));
  });

  it('refuses an over-long catalog entry name BEFORE installing anything', async () => {
    // An identity cannot be clamped without corrupting it, so this refuses —
    // but early, where refusing still costs nothing.
    const { app, calls } = makeApp({
      catalogEntry: { ...NOTION_ENTRY, name: `com.${'x'.repeat(300)}/mcp` },
    });
    const tools = registerAndCapture({ app });

    await expect(
      tools.agor_widgets_request_oauth.cb({ catalogEntryName: 'com.notion/mcp' })
    ).rejects.toThrow(/too long/i);
    expect(calls.find((c) => c.service === 'mcp-catalog/connect')).toBeUndefined();
    expect(appendStub).not.toHaveBeenCalled();
  });

  it('clamps an over-long server display name', async () => {
    const { app } = makeApp({ server: { ...OAUTH_SERVER, display_name: 'N'.repeat(260) } });
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });
    expect(appendStub.mock.calls[0][0].metadata.widget.params.serverName).toHaveLength(200);
  });

  it('substitutes the default reason for a blank one, which `?? default` would not', async () => {
    const { app } = makeApp();
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion', reason: '   ' });
    // The widget schema requires `reason.min(1)`, so an empty string would have
    // thrown a Zod error at the agent instead of reading as "unspecified".
    expect(appendStub.mock.calls[0][0].metadata.widget.params.reason).toMatch(/Connect Notion/);
  });
});

describe('agor_widgets_request_oauth — already connected', () => {
  it('skips the button, attaches, and resumes when a live grant exists', async () => {
    livenessStub.mockResolvedValue({ live: true });
    const { app, calls } = makeApp();
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(payload(result)).toMatchObject({
      status: 'already_present',
      mcp_server_id: 'srv-notion',
    });
    expect(appendStub.mock.calls[0][0].metadata.widget.status).toBe('already_present');
    expect(calls.find((c) => c.service === '/sessions/:id/mcp-servers')).toBeDefined();
    const prompt = calls.find((c) => c.service === '/sessions/:id/prompt');
    expect(JSON.stringify(prompt?.args[0])).toContain('already connected');
  });

  it('checks the grant for the PROMPT ACTOR, not the session owner', async () => {
    const { app } = makeApp({ sessionCreator: 'user-session-owner' });
    const tools = registerAndCapture({ app, userId: 'user-actor' });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(livenessStub).toHaveBeenCalledWith(expect.anything(), 'srv-notion', 'user-actor');
  });
});

describe('agor_widgets_request_oauth — superseding a stale Connect button', () => {
  it('supersedes the earlier pending widget when a new one is minted', async () => {
    superseded.rows = [pendingOAuthWidget('widget-old', 'srv-notion')];
    const { app, supersedeSpy } = makeApp();
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(supersedeSpy).toHaveBeenCalledWith('widget-old', expect.any(String));
  });

  it('supersedes on the already-connected short-circuit too', async () => {
    // THE case where a live Connect button is most obviously stale: the user
    // connected through the Catalog drawer and then re-asked the agent. Clicking
    // the old button would run a full unnecessary re-authorization and queue a
    // second auto-resume prompt that will not coalesce (different widget id).
    livenessStub.mockResolvedValue({ live: true });
    superseded.rows = [pendingOAuthWidget('widget-old', 'srv-notion')];
    const { app, supersedeSpy } = makeApp();
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(payload(result).status).toBe('already_present');
    expect(supersedeSpy).toHaveBeenCalledWith('widget-old', expect.any(String));
  });

  it('supersedes on the no-auth-needed short-circuit too', async () => {
    superseded.rows = [pendingOAuthWidget('widget-old', 'srv-notion')];
    const { app, supersedeSpy } = makeApp({
      catalogEntry: { ...NOTION_ENTRY, auth_type: 'none' },
      connectResult: {
        mcp_server: { ...OAUTH_SERVER, auth: undefined },
        reused_existing_server: false,
      },
    });
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ catalogEntryName: 'com.notion/mcp' });

    expect(supersedeSpy).toHaveBeenCalledWith('widget-old', expect.any(String));
  });

  it('leaves a pending widget for a DIFFERENT server alone', async () => {
    superseded.rows = [pendingOAuthWidget('widget-other', 'srv-linear')];
    const { app, supersedeSpy } = makeApp();
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(supersedeSpy).not.toHaveBeenCalled();
  });

  it('bounds the sweep instead of loading every widget in the session', async () => {
    const { app } = makeApp();
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(superseded.scans[0]).toMatchObject({
      type: 'widget_request',
      options: { newestFirst: true, limit: expect.any(Number) },
    });
  });

  it('does not stop the new request when superseding fails', async () => {
    superseded.rows = [pendingOAuthWidget('widget-old', 'srv-notion')];
    const { app, supersedeSpy } = makeApp();
    supersedeSpy.mockRejectedValueOnce(new Error('row lock timeout') as never);
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });
    expect(payload(result).status).toBe('requested');
  });
});

describe('agor_widgets_request_oauth — fail-closed guards', () => {
  it('refuses on a gateway channel that does not align platform users', async () => {
    const { app } = makeApp({
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
    const tools = registerAndCapture({ app });

    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    ).rejects.toThrow(/align_slack_users/);
    // Nothing minted, nothing installed.
    expect(appendStub).not.toHaveBeenCalled();
  });

  it('proceeds on an aligned gateway channel', async () => {
    const { app } = makeApp({
      customContext: {
        gateway_source: {
          channel_id: 'chan-1',
          channel_name: 'eng-help',
          channel_type: 'slack',
          thread_id: 't1',
        },
      },
      gatewayChannel: { channel_type: 'slack', config: { align_slack_users: true } },
    });
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });
    expect(payload(result).status).toBe('requested');
  });

  it('refuses when the gateway channel cannot be read — an unreadable channel proves nothing', async () => {
    const { app } = makeApp({
      customContext: {
        gateway_source: {
          channel_id: 'chan-1',
          channel_name: 'eng-help',
          channel_type: 'slack',
          thread_id: 't1',
        },
      },
      // No channel row returned.
    });
    const tools = registerAndCapture({ app });
    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    ).rejects.toThrow(/does not align platform users/);
  });

  it('refuses a non-admin minting a shared, workspace-wide connection', async () => {
    const { app } = makeApp({
      server: { ...OAUTH_SERVER, auth: { type: 'oauth', oauth_mode: 'shared' } },
    });
    const tools = registerAndCapture({ app, role: 'member' });
    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    ).rejects.toThrow(/admin/i);
    expect(appendStub).not.toHaveBeenCalled();
  });

  it('allows an admin to mint a shared connection', async () => {
    const { app } = makeApp({
      server: { ...OAUTH_SERVER, auth: { type: 'oauth', oauth_mode: 'shared' } },
    });
    const tools = registerAndCapture({ app, role: 'admin' });
    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });
    expect(payload(result).status).toBe('requested');
    expect(appendStub.mock.calls[0][0].metadata.widget.params.oauthMode).toBe('shared');
  });

  it('refuses to mint into a session the caller neither owns nor administers', async () => {
    const { app } = makeApp({ sessionCreator: 'someone-else' });
    const tools = registerAndCapture({ app, sessionId: 'sess-current' });
    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion', sessionId: 'sess-other' })
    ).rejects.toThrow(/session owner or an admin/i);
  });
});

/**
 * The widget mints into an Agor transcript. A Slack or Discord user is not
 * looking at that transcript, and no platform projects the card into its own
 * thread today — so in a Discord session, which passes the alignment guard and
 * mints a real widget, the agent previously had `{ widget_id, status:
 * "requested" }` and nothing to say.
 */
describe('agor_widgets_request_oauth — what a gateway agent can relay', () => {
  const gatewaySession = (channelType: string) => ({
    customContext: {
      gateway_source: {
        channel_id: 'chan-1',
        channel_name: 'eng-help',
        channel_type: channelType,
        thread_id: 't1',
      },
    },
  });

  beforeEach(() => {
    vi.stubEnv('AGOR_BASE_URL', 'https://agor.example.test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a session deep link and a sentence to paste, in a Discord session', async () => {
    const { app } = makeApp({
      ...gatewaySession('discord'),
      gatewayChannel: { channel_type: 'discord', config: { align_discord_users: true } },
    });
    const tools = registerAndCapture({ app, sessionId: 'sess-1' });

    const result = payload(
      await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    );
    expect(result.status).toBe('requested');
    // The real `getSessionUrl`, so the shape is whatever the UI actually
    // routes on rather than a string this test invented.
    expect(result.session_url).toBe(
      getSessionUrl('sess-1' as SessionID, 'https://agor.example.test')
    );
    expect(result.relay_to_user).toContain(result.session_url);
    expect(result.relay_to_user).toContain('Notion');
  });

  it('says nothing about a link on the canvas, where the card is already visible', async () => {
    const { app } = makeApp();
    const tools = registerAndCapture({ app });

    const result = payload(
      await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    );
    expect(result.status).toBe('requested');
    expect(result.session_url).toBeUndefined();
    expect(result.relay_to_user).toBeUndefined();
  });

  it('omits the link rather than relaying a bind address nobody can open', async () => {
    vi.stubEnv('AGOR_BASE_URL', 'http://0.0.0.0:3030');
    const { app } = makeApp({
      ...gatewaySession('discord'),
      gatewayChannel: { channel_type: 'discord', config: { align_discord_users: true } },
    });
    const tools = registerAndCapture({ app });

    const result = payload(
      await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    );
    expect(result.status).toBe('requested');
    expect(result.session_url).toBeUndefined();
  });
});

describe('agor_widgets_request_oauth — tool description', () => {
  it('tells the agent to resolve the entry first and never to invent a URL', () => {
    const { app } = makeApp();
    const tools = registerAndCapture({ app });
    const desc = tools.agor_widgets_request_oauth.cfg.description ?? '';
    expect(desc).toContain('agor_mcp_catalog_list');
    expect(desc).toMatch(/NEVER invent a URL/i);
    expect(desc).toMatch(/fire-and-forget/i);
  });
});
