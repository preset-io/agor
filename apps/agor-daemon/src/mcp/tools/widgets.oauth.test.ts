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

import { getBaseUrl } from '@agor/core/config';
import { runWithTenantContext } from '@agor/core/db';
import type { MessageID, SessionID } from '@agor/core/types';
import { getSessionUrl } from '@agor/core/utils/url';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/append-system-message.js', () => ({
  appendSystemMessage: vi.fn(),
}));
// Only the DATABASE read is stubbed. `mcpOAuthGrantIsConnected` — the verdict
// the mint gate asks of that read — is kept real on purpose: stubbing it would
// make the convergence suite at the bottom of this file assert that two
// surfaces agree with a test double rather than with each other.
vi.mock('../../services/mcp-oauth-grant-liveness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mcp-oauth-grant-liveness.js')>()),
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

import { hostedTenantRouting } from '../../../test/hosted-tenant-routing-fixture.js';
import type { MCPOAuthGrantLiveness } from '../../services/mcp-oauth-grant-liveness.js';
import {
  mcpOAuthGrantIsConnected,
  resolveMCPOAuthGrantLiveness,
} from '../../services/mcp-oauth-grant-liveness.js';
import { appendSystemMessage } from '../../utils/append-system-message.js';
import { registerAllWidgets } from '../../widgets/index.js';
import { _resetWidgetRegistryForTests } from '../../widgets/registry.js';
import { summarizeMcpServer } from './mcp-servers.js';
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
  /** Make the attach fail for a reason other than the owner-or-admin rule. */
  attachError?: Error;
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
        // The real route's rule (`checkSessionOwnerOrAdmin`), not an
        // always-succeeds stub: that stub is how a non-owner's failing attach
        // went unnoticed.
        const user = (args[1] as { user?: { user_id?: string; role?: string } }).user;
        if (user?.user_id !== (opts.sessionCreator ?? 'user-actor') && user?.role !== 'admin') {
          throw new Error('Forbidden: only the session owner or an admin');
        }
        if (opts.attachError) throw opts.attachError;
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
  /** `this.db` for the tool. A real guarded handle for the hosted-mode tests. */
  db?: unknown;
  /** Authenticated tenant, which is what arms the MCP tenant database scope. */
  tenantId?: string;
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
    db: (ctx.db ?? {}) as never,
    userId: userId as never,
    sessionId: (ctx.sessionId ?? 'sess-1') as never,
    authenticatedUser: { user_id: userId, role: ctx.role ?? 'member' } as never,
    baseServiceParams: {
      user: { user_id: userId, role: ctx.role ?? 'member' },
      authenticated: true,
      provider: 'mcp',
      ...(ctx.tenantId ? { tenant: { tenant_id: ctx.tenantId } } : {}),
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

  it('validates params at the seam on the short-circuit path too, not just the pending one', async () => {
    // The `already_present` branch builds its params with `satisfies
    // OAuthWidgetParams` — a compile-time check that strips nothing and
    // narrows nothing at runtime. A server row whose `oauth_mode` is not one
    // of the two the schema allows used to be frozen onto the widget row
    // verbatim; the seam's `paramsSchema.parse` now refuses it.
    livenessStub.mockResolvedValue({ live: true });
    const { app } = makeApp({
      server: { ...OAUTH_SERVER, auth: { type: 'oauth', oauth_mode: 'nonsense' } },
    });
    const tools = registerAndCapture({ app });

    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    ).rejects.toThrow();
    expect(appendStub).not.toHaveBeenCalled();
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

describe('agor_widgets_request_oauth — an existing catalog install requested by id', () => {
  // `mcp-catalog/connect` stamps `catalog_entry_name` on the row it installs,
  // so this is the same server the catalog path created.
  const INSTALLED = { ...OAUTH_SERVER, catalog_entry_name: 'com.notion/mcp' };

  it('carries the entry disclosure onto the widget that supersedes the first one', async () => {
    // §5.4: the agent may acknowledge the disclosure on the user's behalf only
    // because the text then reaches the user above the Connect button. A
    // re-request by id supersedes the widget that carried it, so the
    // replacement has to carry it too — or nobody ever reads it.
    const { app, supersedeSpy } = makeApp({
      server: INSTALLED,
      connectResult: { mcp_server: INSTALLED, reused_existing_server: false },
    });
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ catalogEntryName: 'com.notion/mcp' });
    const first = appendStub.mock.calls[0][0].metadata.widget;
    expect(first.params.permissionDisclosure).toBe(NOTION_ENTRY.permission_disclosure);

    superseded.rows = [pendingOAuthWidget('widget-first', 'srv-notion')];
    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(supersedeSpy).toHaveBeenCalledWith('widget-first', expect.any(String));
    const second = appendStub.mock.calls[1][0].metadata.widget;
    expect(second.status).toBe('pending');
    expect(second.params.catalogEntryName).toBe('com.notion/mcp');
    expect(second.params.permissionDisclosure).toBe(NOTION_ENTRY.permission_disclosure);
  });

  it('refuses, before superseding anything, when the entry has left the catalog', async () => {
    // Without the entry there is no text to show, and minting a Connect button
    // with no disclosure is exactly the gap this closes. A generic notice is
    // not what anybody acknowledged. Refusing leaves the pending widget (if
    // any) in place and sends the user to the human path.
    const { app, supersedeSpy } = makeApp({ server: INSTALLED, catalogEntry: null });
    const tools = registerAndCapture({ app });
    superseded.rows = [pendingOAuthWidget('widget-first', 'srv-notion')];

    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    ).rejects.toThrow(/cannot show what it can access.*My Servers/s);
    expect(supersedeSpy).not.toHaveBeenCalled();
    expect(appendStub).not.toHaveBeenCalled();
  });

  it('still attaches an already-connected server whose entry has left the catalog', async () => {
    // No Connect button is shown on this path, so there is nothing for the
    // missing disclosure to precede; refusing would only strand a working
    // connection.
    livenessStub.mockResolvedValue({ live: true });
    const { app, calls } = makeApp({ server: INSTALLED, catalogEntry: null });
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(payload(result).status).toBe('already_present');
    expect(calls.find((c) => c.service === '/sessions/:id/mcp-servers')).toBeDefined();
  });

  it('refuses an unshowable disclosure on this path too, rather than shortening it', async () => {
    const { app } = makeApp({
      server: INSTALLED,
      catalogEntry: { ...NOTION_ENTRY, permission_disclosure: 'x'.repeat(4_001) },
    });
    const tools = registerAndCapture({ app });

    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    ).rejects.toThrow(/will not shorten what you are agreeing to/);
    expect(appendStub).not.toHaveBeenCalled();
  });

  it('does not consult the catalog for a server that was not installed from it', async () => {
    const { app, calls } = makeApp();
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(calls.find((c) => c.service === 'mcp-catalog')).toBeUndefined();
    expect(appendStub.mock.calls[0][0].metadata.widget.params.permissionDisclosure).toBeUndefined();
  });
});

describe('agor_widgets_request_oauth — catalog-owned fields cannot orphan an install', () => {
  it('carries a long permission disclosure through whole', async () => {
    // The disclosure is the consent: §5.4 lets an agent satisfy
    // `acknowledged_disclosure` on a human's behalf precisely because this text
    // then reaches the human above the Connect button. It used to be silently
    // clipped to 1000 characters, which is the one thing that must not happen
    // to it — the tail of a permissions paragraph is where "and can delete"
    // lives. The longest reviewed entry today is 808 characters.
    const long = `${'x'.repeat(1_400)} and can delete them.`;
    const { app, calls } = makeApp({
      catalogEntry: { ...NOTION_ENTRY, permission_disclosure: long },
    });
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({
      catalogEntryName: 'com.notion/mcp',
    });

    expect(payload(result).status).toBe('requested');
    expect(appendStub.mock.calls[0][0].metadata.widget.params.permissionDisclosure).toBe(long);
    const connect = calls.find((c) => c.service === 'mcp-catalog/connect');
    const connectArgs = connect?.args[0] as { acknowledged_disclosure: string } | undefined;
    expect(connectArgs?.acknowledged_disclosure).toBe(long);
  });

  it('refuses an unshowable disclosure BEFORE installing, rather than shortening it', async () => {
    // Past the bound the answer is a refusal, for the same reason: an entry
    // nobody can connect is a curation bug someone fixes, while a disclosure
    // missing its last sentence is one nobody notices. Refused early, so the
    // refusal still costs no orphaned server row.
    const { app, calls } = makeApp({
      catalogEntry: { ...NOTION_ENTRY, permission_disclosure: 'x'.repeat(4_001) },
    });
    const tools = registerAndCapture({ app });

    await expect(
      tools.agor_widgets_request_oauth.cb({ catalogEntryName: 'com.notion/mcp' })
    ).rejects.toThrow(/will not shorten what you are agreeing to/);
    expect(calls.find((c) => c.service === 'mcp-catalog/connect')).toBeUndefined();
    expect(appendStub).not.toHaveBeenCalled();
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

  it('attaches before recording, and retires a stale Connect card only after', async () => {
    livenessStub.mockResolvedValue({ live: true });
    superseded.rows = [pendingOAuthWidget('widget-stale', 'srv-notion')];
    const { app, calls, supersedeSpy } = makeApp();
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(payload(result)).toMatchObject({ status: 'already_present', attached: true });
    expect(appendStub.mock.calls[0][0].metadata.widget.result_meta).toMatchObject({
      attached: true,
    });
    expect(supersedeSpy).toHaveBeenCalledWith('widget-stale', expect.any(String));
    // The replacement exists before the card it replaces is retired.
    expect(appendStub.mock.invocationCallOrder[0]).toBeLessThan(
      supersedeSpy.mock.invocationCallOrder[0]
    );
    expect(calls.find((c) => c.service === '/sessions/:id/mcp-servers')).toBeDefined();
  });

  it('records attached=false for a prompter who may not configure the session (D6)', async () => {
    // A collaborator allowed to prompt a shared session, who already holds a
    // grant, asks for the server. The attach route refuses them — so the
    // shortcut asks first, as the resolve path does, and records the outcome
    // instead of throwing after it had already dismissed the pending card.
    livenessStub.mockResolvedValue({ live: true });
    superseded.rows = [pendingOAuthWidget('widget-stale', 'srv-notion')];
    const { app, calls, supersedeSpy } = makeApp({ sessionCreator: 'user-session-owner' });
    const tools = registerAndCapture({ app, userId: 'user-actor' });

    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(payload(result)).toMatchObject({ status: 'already_present', attached: false });
    // Asked, not attempted.
    expect(calls.find((c) => c.service === '/sessions/:id/mcp-servers')).toBeUndefined();
    const widget = appendStub.mock.calls[0][0].metadata.widget;
    expect(widget.status).toBe('already_present');
    expect(widget.result_meta).toEqual({
      mcp_server_id: 'srv-notion',
      name: 'Notion',
      oauth_mode: 'per_user',
      attached: false,
    });
    // The agent is told what happened and who can fix it, and is resumed.
    const prompt = JSON.stringify(calls.find((c) => c.service === '/sessions/:id/prompt')?.args[0]);
    expect(prompt).toContain('could not be attached');
    expect(prompt).toContain('Ask them to attach');
    // The stale button is retired only once that outcome is on the record.
    expect(appendStub.mock.invocationCallOrder[0]).toBeLessThan(
      supersedeSpy.mock.invocationCallOrder[0]
    );
  });

  it('records attached=false on the catalog no-auth path too, leaving the install inert', async () => {
    const openServer = { ...OAUTH_SERVER, auth: undefined };
    const { app, calls } = makeApp({
      sessionCreator: 'user-session-owner',
      catalogEntry: { ...NOTION_ENTRY, auth_type: 'none' },
      connectResult: { mcp_server: openServer, reused_existing_server: false },
    });
    const tools = registerAndCapture({ app, userId: 'user-actor' });

    const result = await tools.agor_widgets_request_oauth.cb({
      catalogEntryName: 'com.notion/mcp',
    });

    expect(payload(result)).toMatchObject({ status: 'already_present', attached: false });
    // The install is the caller's private, unattached row — what every
    // catalog install from this tool is until it can be attached.
    expect(calls.find((c) => c.service === 'mcp-catalog/connect')).toBeDefined();
    expect(calls.find((c) => c.service === '/sessions/:id/mcp-servers')).toBeUndefined();
    expect(appendStub.mock.calls[0][0].metadata.widget.result_meta.attached).toBe(false);
  });

  it('leaves the pending card live when the attach itself fails', async () => {
    // Any refusal other than D6's propagates, as on the resolve path — and
    // because nothing is superseded before the outcome is known, the user's
    // Connect button is still there to retry with.
    livenessStub.mockResolvedValue({ live: true });
    superseded.rows = [pendingOAuthWidget('widget-pending', 'srv-notion')];
    const { app, calls, supersedeSpy } = makeApp({
      attachError: new Error('That MCP server is private to another user'),
    });
    const tools = registerAndCapture({ app });

    await expect(
      tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    ).rejects.toThrow('private to another user');

    expect(supersedeSpy).not.toHaveBeenCalled();
    expect(appendStub).not.toHaveBeenCalled();
    expect(calls.find((c) => c.service === '/sessions/:id/prompt')).toBeUndefined();
  });

  it('checks the grant for the PROMPT ACTOR, not the session owner', async () => {
    const { app } = makeApp({ sessionCreator: 'user-session-owner' });
    const tools = registerAndCapture({ app, userId: 'user-actor' });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(livenessStub).toHaveBeenCalledWith(expect.anything(), 'srv-notion', 'user-actor');
  });

  it('treats a grant that is one refresh away from usable as already connected', async () => {
    // D4.1. This exact state — bound, access token lapsed, refresh token on
    // file and of known outcome — is what `agor_mcp_servers_auth_status` has
    // already told this agent is `oauth_authenticated: true`, and what the
    // UI's auth badge shows as connected. Rendering a Connect button for it
    // would be Agor saying the server works and then offering to connect it.
    //
    // Nothing is granted by the short-circuit: the credential exists either
    // way, and if the JIT refresh does fail at call time the reactive recovery
    // lane offers a reconnect, which is what that lane is for.
    livenessStub.mockResolvedValue({
      live: false,
      reason: 'expired',
      refreshable: true,
    } satisfies MCPOAuthGrantLiveness);
    const { app, calls } = makeApp();
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });

    expect(payload(result)).toMatchObject({
      status: 'already_present',
      mcp_server_id: 'srv-notion',
    });
    // Attached and resumed, exactly as for a live grant — not merely "no
    // button rendered".
    expect(calls.find((c) => c.service === '/sessions/:id/mcp-servers')).toBeDefined();
    expect(
      JSON.stringify(calls.find((c) => c.service === '/sessions/:id/prompt')?.args[0])
    ).toContain('already connected');
  });

  it('still renders the button for a refresh whose outcome nobody knows', async () => {
    // The other half of the rule, so the widening above is not read as "any
    // grant row will do". An `ambiguous` refresh — nobody knows whether the
    // refresh token was already spent — is not `refreshable`, so this is a
    // server the user really may have to sign in to again.
    livenessStub.mockResolvedValue({
      live: false,
      reason: 'refreshing',
      refreshable: false,
    } satisfies MCPOAuthGrantLiveness);
    const { app } = makeApp();
    const tools = registerAndCapture({ app });

    const result = await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });
    expect(payload(result).status).toBe('requested');
  });
});

/**
 * The mint gate and the agent-facing read answer the SAME question (D4.1).
 *
 * This is the invariant that went missing twice: `agor_mcp_servers_auth_status`
 * told an agent a server was connected while this tool would still have minted
 * a Connect button for it, and no test on either side could see the
 * disagreement because each pinned its own surface.
 *
 * So the assertion is not "the short-circuit fired" but "the short-circuit
 * fired exactly when the agent-facing read says connected", over every liveness
 * shape, with the shared verdict left unstubbed as the hinge. A future change
 * that widens or narrows one surface alone fails here.
 *
 * `mcp-servers.auth-status.test.ts` pins the other end of the same chain: that
 * the agent-facing read is `mcpOAuthGrantIsConnected` of a REAL database read,
 * state by state, and that it matches the UI badge's rule.
 */
describe('the mint gate and the agent-facing read agree, state by state', () => {
  const summarizeCtx = {
    db: {} as never,
    baseServiceParams: { user: { user_id: 'user-actor', role: 'member' }, authenticated: true },
  } as never;

  it.each([
    { state: 'a live grant', liveness: { live: true, reason: 'live', refreshable: false } },
    { state: 'no grant at all', liveness: { live: false, reason: 'no_grant', refreshable: false } },
    {
      state: 'an expired grant one refresh away from usable',
      liveness: { live: false, reason: 'expired', refreshable: true },
    },
    {
      state: 'a refresh in flight with a spendable token behind it',
      liveness: { live: false, reason: 'refreshing', refreshable: true },
    },
    {
      state: 'a refresh of unknown outcome',
      liveness: { live: false, reason: 'refreshing', refreshable: false },
    },
    {
      state: 'a grant whose server configuration moved under it',
      liveness: { live: false, reason: 'unbound', refreshable: false },
    },
  ] satisfies Array<{ state: string; liveness: MCPOAuthGrantLiveness }>)(
    '$state',
    async ({ liveness }) => {
      livenessStub.mockResolvedValue(liveness);
      const { app } = makeApp();
      const tools = registerAndCapture({ app });

      const minted = payload(
        await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
      ).status;
      const summary = await summarizeMcpServer(summarizeCtx, OAUTH_SERVER as never);

      expect(minted === 'already_present').toBe(summary.oauth_authenticated);
      // And both are the one shared verdict, not merely each other.
      expect(summary.oauth_authenticated).toBe(mcpOAuthGrantIsConnected(liveness));
    }
  );
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

  /**
   * The card projection's own trigger is an in-process defer. A restart, or
   * any throw before the first link commits, would otherwise orphan the
   * widget's Slack face silently — after the user was told a card is coming.
   */
  it('stamps the durable card marker on a gateway mint, in the same row insert', async () => {
    const { app } = makeApp({
      ...gatewaySession('slack'),
      gatewayChannel: { channel_type: 'slack', config: { align_slack_users: true } },
    });
    const tools = registerAndCapture({ app, sessionId: 'sess-1' });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });
    expect(appendStub.mock.calls[0][0].metadata.widget.slack_connect_due_at).toEqual(
      expect.any(String)
    );
  });

  it('leaves a canvas mint off the sweep entirely', async () => {
    const { app } = makeApp();
    const tools = registerAndCapture({ app });

    await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' });
    expect(appendStub.mock.calls[0][0].metadata.widget.slack_connect_due_at).toBeUndefined();
  });

  it('never marks a terminal short-circuit row, which has no card to owe', async () => {
    livenessStub.mockResolvedValue({ live: true });
    const { app } = makeApp({
      ...gatewaySession('slack'),
      gatewayChannel: { channel_type: 'slack', config: { align_slack_users: true } },
    });
    const tools = registerAndCapture({ app, sessionId: 'sess-1' });

    const result = payload(
      await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    );
    expect(result.status).toBe('already_present');
    expect(appendStub.mock.calls[0][0].metadata.widget.slack_connect_due_at).toBeUndefined();
  });

  /**
   * The canvas case is the ONLY one that may now say nothing.
   *
   * The tool's description defines the absence of `session_url` as "not a
   * gateway thread, the user can see the card", so an absence that means
   * anything else licenses the agent to promise a button — which is exactly
   * what it did on 2026-09-16. `link_unavailable` is what separates the two.
   */
  it('says nothing about a link on the canvas, where the card is already visible', async () => {
    const { app } = makeApp();
    const tools = registerAndCapture({ app });

    const result = payload(
      await tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
    );
    expect(result.status).toBe('requested');
    expect(result.session_url).toBeUndefined();
    expect(result.relay_to_user).toBeUndefined();
    expect(result.link_unavailable).toBeUndefined();
  });

  it.each([
    ['a bind address', 'http://0.0.0.0:3030'],
    ['a loopback address', 'http://localhost:3030'],
  ])('says the link is unavailable rather than relaying %s', async (_label, baseUrl) => {
    vi.stubEnv('AGOR_BASE_URL', baseUrl);
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
    // The negative, stated. Absence alone reads as the canvas case.
    expect(result.link_unavailable).toBe(true);
    expect(result.relay_to_user).toEqual(expect.any(String));
    // Relayed into a Slack channel, so it carries nothing an administrator
    // would act on and nothing an attacker would learn: no configuration key,
    // no hostname, no internal category.
    expect(result.relay_to_user).not.toMatch(
      /AGOR_BASE_URL|base_url|config\.yaml|localhost|0\.0\.0\.0|not_browser_reachable/i
    );
    // And no URL of any kind, which is the whole reason it exists.
    expect(result.relay_to_user).not.toMatch(/https?:\/\//);
  });
});

/**
 * Hosted mode, where the deep link is the only thing the agent can hand over.
 *
 * `getBaseUrl` resolves a hosted tenant's origin from durable routing, not
 * from `AGOR_BASE_URL`, and needs a database handle to do it. This call site
 * passed none — so on the cloud stack the resolution threw into
 * `gatewaySessionConnectUrl`'s own catch, every gateway mint came back with no
 * `session_url` and no `relay_to_user`, and the agent promised a Connect
 * button that the Slack user had no way to reach. It is also the fallback the
 * kill-switch runbook promises still works when the Slack card is off, and on
 * every platform that has no card at all.
 *
 * The suites above could not see it: they run single-tenant, where the hosted
 * branch is never taken and the missing argument is inert.
 */
describe('agor_widgets_request_oauth — the deep link on a hosted tenant', () => {
  const TENANT = 'tenant-a';
  const TENANT_ORIGIN = 'https://tenant-a.example.test';
  const gatewayDiscord = {
    customContext: {
      gateway_source: {
        channel_id: 'chan-1',
        channel_name: 'eng-help',
        channel_type: 'discord',
        thread_id: 't1',
      },
    },
    gatewayChannel: { channel_type: 'discord', config: { align_discord_users: true } },
  };

  let hosted: Awaited<ReturnType<typeof hostedTenantRouting>> | undefined;
  afterEach(async () => {
    await hosted?.cleanup();
    hosted = undefined;
  });

  it('relays the tenant origin, never the deployment cell origin', async () => {
    hosted = await hostedTenantRouting({ tenantId: TENANT, origin: TENANT_ORIGIN });

    // The shape that shipped: tenant identity, no handle, no scope. Pinned by
    // cast because `getBaseUrl` no longer lets a caller express it — this is
    // what the required parameter buys, and the assertion says so rather than
    // leaving it to a commit message.
    await expect(
      runWithTenantContext(TENANT, () => (getBaseUrl as unknown as () => Promise<string>)())
    ).rejects.toThrow(/tenant database/i);

    const { app } = makeApp(gatewayDiscord);
    const tools = registerAndCapture({ app, sessionId: 'sess-1', db: hosted.db, tenantId: TENANT });
    const result = payload(
      await runWithTenantContext(TENANT, () =>
        tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
      )
    );

    expect(result.status).toBe('requested');
    expect(result.session_url).toBe(getSessionUrl('sess-1' as SessionID, TENANT_ORIGIN));
    expect(new URL(result.session_url).origin).toBe(TENANT_ORIGIN);
    // `AGOR_BASE_URL` is the cell every tenant shares. A link carrying it
    // would send the user to an origin their workspace does not answer on.
    expect(result.session_url).not.toContain(new URL(hosted.cellBaseUrl).host);
    expect(result.relay_to_user).toContain(result.session_url);
  });

  it('says the link is unavailable for a tenant with no routing yet', async () => {
    hosted = await hostedTenantRouting({ tenantId: TENANT });

    const { app } = makeApp(gatewayDiscord);
    const tools = registerAndCapture({ app, sessionId: 'sess-1', db: hosted.db, tenantId: TENANT });
    const result = payload(
      await runWithTenantContext(TENANT, () =>
        tools.agor_widgets_request_oauth.cb({ mcpServerId: 'srv-notion' })
      )
    );

    // The widget is still minted — the canvas card is real, and is what the
    // user actually used — but an uninitialised tenant resolves to `''`, which
    // is not a URL and must not become the cell origin, a relative path, or a
    // sentence with a hole in it.
    expect(result.status).toBe('requested');
    expect(result.session_url).toBeUndefined();
    // And the absence is NAMED. `gatewaySessionConnectUrl` answered `null` for
    // both "canvas session" and "gateway session, no link", while the tool's
    // description defined the absence as the first — so the agent was told, by
    // contract, that the user could see a card they could not.
    expect(result.link_unavailable).toBe(true);
    expect(result.relay_to_user).toEqual(expect.any(String));
    expect(result.relay_to_user).not.toContain(TENANT_ORIGIN);
    expect(result.relay_to_user).not.toContain(new URL(hosted.cellBaseUrl).host);
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
