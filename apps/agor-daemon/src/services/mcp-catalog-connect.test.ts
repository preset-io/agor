/**
 * Marketplace connect: what the endpoint derives from the catalog rather than
 * from its caller, and what it refuses.
 */

import type { AuthenticatedParams, MCPCatalogEntry, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMCPCatalogConnectService } from './mcp-catalog-connect.js';

const { probeRemoteAuthType } = vi.hoisted(() => ({ probeRemoteAuthType: vi.fn() }));
vi.mock('@agor/core/mcp-catalog', () => ({ probeRemoteAuthType }));

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;

/** The registry name — the catalog's unique key, and what an install records. */
const LINEAR = 'com.linear/linear';

const CURATED: MCPCatalogEntry = {
  catalog_entry_id: '00000000-0000-7000-8000-0000000ce001' as MCPCatalogEntry['catalog_entry_id'],
  created_at: new Date(),
  updated_at: new Date(),
  name: LINEAR,
  title: 'Linear',
  benefit: 'Read and update your Linear issues.',
  starter_prompt: 'List the issues assigned to me this cycle.',
  permission_disclosure: 'Reads and writes issues in the Linear workspaces you authorise.',
  transport: 'streamable-http',
  remote_url: 'https://mcp.linear.app/mcp',
  has_remote: true,
  has_package: false,
  curated: true,
  verified: false,
  probed_auth_type: 'none',
};

/** A row as marketplace connect would have written it for {@link CURATED}. */
function installOf(overrides: Record<string, unknown> = {}) {
  return {
    mcp_server_id: 'server-existing',
    catalog_entry_name: LINEAR,
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: { type: 'none' },
    enabled: true,
    ...overrides,
  };
}

function buildApp(entry: MCPCatalogEntry, existingServers: unknown[] = []) {
  const created: Record<string, unknown[]> = { mcpServers: [], sessions: [], attachments: [] };
  const removed: string[] = [];
  const services: Record<string, unknown> = {
    'mcp-catalog': { get: vi.fn(async () => entry) },
    'mcp-servers': {
      find: vi.fn(async () => existingServers),
      create: vi.fn(async (data: Record<string, unknown>) => {
        created.mcpServers.push(data);
        return { ...data, mcp_server_id: 'server-1' };
      }),
      remove: vi.fn(async (id: string) => {
        created.mcpServers = created.mcpServers.filter(
          (server) => (server as { mcp_server_id?: string }).mcp_server_id !== id
        );
        removed.push(id);
        return { mcp_server_id: id };
      }),
    },
    sessions: {
      create: vi.fn(async (data: Record<string, unknown>) => {
        created.sessions.push(data);
        return { ...data, session_id: 'session-1' };
      }),
    },
    '/sessions/:id/mcp-servers': {
      create: vi.fn(async (data: unknown, params: { route?: { id?: string } }) => {
        created.attachments.push({ data, sessionId: params.route?.id });
        return data;
      }),
    },
  };
  return {
    app: { service: (path: string) => services[path] },
    services,
    created,
    removed,
  };
}

const params = {
  provider: 'rest',
  user: { user_id: ALICE, role: 'member' },
} as unknown as AuthenticatedParams;

const request = {
  catalog_key: LINEAR,
  branch_id: 'branch-1',
  agentic_tool: 'claude-code' as const,
  acknowledged_disclosure: CURATED.permission_disclosure as string,
};

describe('mcp-catalog/connect', () => {
  beforeEach(() => {
    probeRemoteAuthType.mockReset();
  });

  it('derives the whole server config from the catalog row', async () => {
    const { app, created } = buildApp(CURATED);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(created.mcpServers[0]).toMatchObject({
      name: 'linear',
      display_name: 'Linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      scope: 'session',
      auth: { type: 'none' },
    });
    // Neither ownership nor provenance is decided here — the mcp-servers
    // create hook stamps both.
    expect(created.mcpServers[0]).not.toHaveProperty('owner_user_id');
    expect(result.starter_prompt).toBe('List the issues assigned to me this cycle.');
  });

  it('lands on a session with the server attached', async () => {
    const { app, created } = buildApp(CURATED);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(created.sessions[0]).toMatchObject({ branch_id: 'branch-1', status: 'idle' });
    expect(created.attachments[0]).toEqual({
      data: { mcpServerId: 'server-1' },
      sessionId: 'session-1',
    });
    expect(result.session.session_id).toBe('session-1');
  });

  it('reuses an install rather than creating a second row', async () => {
    const existing = installOf();
    const { app, services, created } = buildApp(CURATED, [existing]);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(created.mcpServers).toHaveLength(0);
    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-existing');
    expect(
      (services['mcp-servers'] as { find: ReturnType<typeof vi.fn> }).find
    ).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ usableByUserId: ALICE }) })
    );
  });

  it('reuses the install after the entry is withdrawn and republished', async () => {
    // A republication is a delete and a re-create, so the entry for the same
    // server comes back under an id nothing installed before it ever saw.
    const republished: MCPCatalogEntry = {
      ...CURATED,
      catalog_entry_id:
        '00000000-0000-7000-8000-0000000ce002' as MCPCatalogEntry['catalog_entry_id'],
    };
    expect(republished.catalog_entry_id).not.toBe(CURATED.catalog_entry_id);

    const existing = installOf();
    const { app, services, created } = buildApp(republished, [existing]);

    const result = await createMCPCatalogConnectService(app).create(
      { ...request, catalog_key: existing.catalog_entry_name },
      params
    );

    // What the install recorded is still a key the catalog answers to, so
    // provenance resolves to the row that now describes the same server.
    expect((services['mcp-catalog'] as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalledWith(
      LINEAR,
      expect.anything()
    );
    // And reuse recognises that install as this entry's, rather than reading
    // the unfamiliar id as a server the user has not connected yet and adding
    // a second row beside the one they already have.
    expect(created.mcpServers).toHaveLength(0);
    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-existing');
  });

  it('does not reuse a server whose endpoint is not the catalog entry’s', async () => {
    // Two routes reach this row and reuse cannot tell them apart, so it must
    // not have to: a member forges the stamp on a server of their own, which
    // is a string printed on every card in the marketplace; or they install
    // the entry properly and then patch the `url`, which on their own private
    // server they are allowed to do. Either way the next connect would hand
    // the caller an endpoint the catalog never named.
    const redirected = installOf({
      mcp_server_id: 'server-redirected',
      url: 'https://collector.evil.example/mcp',
    });
    const { app, created } = buildApp(CURATED, [redirected]);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(result.reused_existing_server).toBe(false);
    expect(result.mcp_server.mcp_server_id).not.toBe('server-redirected');
    expect(created.mcpServers).toHaveLength(1);
    expect(created.mcpServers[0]).toMatchObject({ url: 'https://mcp.linear.app/mcp' });
  });

  it('does not reuse an install whose transport no longer matches', async () => {
    const switched = installOf({ mcp_server_id: 'server-switched', transport: 'sse' });
    const { app, created } = buildApp(CURATED, [switched]);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(result.reused_existing_server).toBe(false);
    expect(created.mcpServers).toHaveLength(1);
  });

  it('does not reuse an install whose auth configuration has drifted', async () => {
    // Connect only serves entries whose probe said `none`, and creates them
    // with `auth: { type: 'none' }`, so any auth at all means the row stopped
    // being this entry's install. Left tunable it would be the sharpest edge
    // here: `oauth` with a caller-chosen authorization endpoint sends the
    // user's browser somewhere the catalog never named, and under `allow_crud`
    // the row is shared, so one member's edit is served to another member.
    const reAuthed = installOf({
      mcp_server_id: 'server-reauthed',
      auth: { type: 'oauth', oauth_authorization_url: 'https://evil.example/authorize' },
    });
    const { app, created } = buildApp(CURATED, [reAuthed]);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(result.reused_existing_server).toBe(false);
    expect(created.mcpServers).toHaveLength(1);
    expect(created.mcpServers[0]).toMatchObject({ auth: { type: 'none' } });
  });

  it('does not reuse an install carrying custom headers', async () => {
    // Agor redacts every custom header value on read and documents them as
    // secret-bearing; it has no notion of a harmless one. Reuse cannot draw a
    // line the rest of the codebase declines to draw, so a catalog install —
    // which is created with no headers — keeps none.
    const withHeaders = installOf({
      mcp_server_id: 'server-headers',
      headers: { 'X-Api-Key': 'sk-live-1' },
    });
    const { app, created } = buildApp(CURATED, [withHeaders]);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(result.reused_existing_server).toBe(false);
    expect(created.mcpServers).toHaveLength(1);
  });

  it('does not reuse a disabled install', async () => {
    // A session resolves its servers with `enabledOnly`, so attaching a
    // disabled row would report success and hand back a session whose agent
    // never sees the server. Connect declines to re-enable it instead: the row
    // may be shared and switched off deliberately, and flipping somebody
    // else's decision is not what "connect this entry" asked for.
    const disabled = installOf({ mcp_server_id: 'server-disabled', enabled: false });
    const { app, created } = buildApp(CURATED, [disabled]);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(result.reused_existing_server).toBe(false);
    expect(created.mcpServers).toHaveLength(1);
    expect(created.mcpServers[0]).not.toMatchObject({ enabled: false });
  });

  it('passes over a drifted row and takes the caller’s real install', async () => {
    // Drift disqualifies one row, not the search. Somebody who has both an
    // edited row and a genuine install gets the genuine one rather than a
    // third row beside them.
    const drifted = installOf({
      mcp_server_id: 'server-drifted',
      auth: { type: 'bearer', token: 'sk-1' },
    });
    const intact = installOf({ mcp_server_id: 'server-intact' });
    const { app, created } = buildApp(CURATED, [drifted, intact]);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(created.mcpServers).toHaveLength(0);
    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-intact');
  });

  it('reuses an install the owner has renamed or relabelled', async () => {
    // What is genuinely cosmetic stays the owner's to change. This is the
    // guard against over-correcting: a second row for a benign edit would be
    // its own bug, so nothing here may cost somebody their install.
    const tuned = installOf({
      name: 'my-linear',
      display_name: 'Linear (work)',
      description: 'my notes',
      scope: 'global',
      url: 'https://mcp.linear.app/mcp/',
    });
    const { app, created } = buildApp(CURATED, [tuned]);

    const result = await createMCPCatalogConnectService(app).create(request, params);

    expect(created.mcpServers).toHaveLength(0);
    expect(result.reused_existing_server).toBe(true);
    expect(result.mcp_server.mcp_server_id).toBe('server-existing');
  });

  it('passes provenance to the mcp-servers service out of band, not in the payload', async () => {
    // The stamp is not the caller's to submit — see `authorizeMcpServerWrite`.
    // Connect names the entry it resolved on params the request cannot reach,
    // so the trusted path is the only one that can produce a stamp.
    const { app, services, created } = buildApp(CURATED);

    await createMCPCatalogConnectService(app).create(request, params);

    expect(created.mcpServers[0]).not.toHaveProperty('catalog_entry_name');
    expect(
      (services['mcp-servers'] as { create: ReturnType<typeof vi.fn> }).create
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mcpCatalogInstall: { entry_name: LINEAR } })
    );
  });

  it('refuses a connect that never showed what the server can access', async () => {
    const { app, created } = buildApp(CURATED);

    await expect(
      createMCPCatalogConnectService(app).create(
        { ...request, acknowledged_disclosure: '' },
        params
      )
    ).rejects.toThrow(/acknowledged_disclosure is required/);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('refuses a disclosure that no longer matches the catalog row', async () => {
    const { app, created } = buildApp(CURATED);

    await expect(
      createMCPCatalogConnectService(app).create(
        { ...request, acknowledged_disclosure: 'Reads nothing at all.' },
        params
      )
    ).rejects.toThrow(/has changed since it was shown/);
    expect(created.mcpServers).toHaveLength(0);
  });

  it('refuses an uncurated entry', async () => {
    const { app } = buildApp({ ...CURATED, curated: false });

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /has not been reviewed/
    );
  });

  it('refuses an entry with no remote endpoint', async () => {
    const { app } = buildApp({
      ...CURATED,
      has_remote: false,
      remote_url: undefined,
      transport: 'stdio',
    });

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /no remote endpoint/
    );
  });

  it('refuses an entry that needs authentication', async () => {
    const { app } = buildApp({ ...CURATED, probed_auth_type: 'oauth' });

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /requires authentication/
    );
  });

  it('probes when the catalog has not recorded a verdict', async () => {
    probeRemoteAuthType.mockResolvedValue({ probed_auth_type: 'none', probed_at: new Date() });
    const { app, created } = buildApp({ ...CURATED, probed_auth_type: 'unknown' });

    await createMCPCatalogConnectService(app).create(request, params);

    expect(probeRemoteAuthType).toHaveBeenCalledWith('https://mcp.linear.app/mcp');
    expect(created.mcpServers).toHaveLength(1);
  });

  it('does not read an unprobed entry as open', async () => {
    probeRemoteAuthType.mockResolvedValue({ probed_auth_type: 'oauth', probed_at: new Date() });
    const { app, created } = buildApp({ ...CURATED, probed_auth_type: 'unknown' });

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /requires authentication/
    );
    expect(created.mcpServers).toHaveLength(0);
    expect(created.sessions).toHaveLength(0);
  });

  it('takes back the server it created when the session cannot be made', async () => {
    const { app, services, removed } = buildApp(CURATED);
    (services.sessions as { create: ReturnType<typeof vi.fn> }).create.mockRejectedValue(
      new Error('branch not found')
    );

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /branch not found/
    );
    expect(removed).toEqual(['server-1']);
    // Undoing this request's own write is the daemon's business, not another
    // authorization decision — the row was created moments ago under the
    // caller's own params, so the delete is deliberately internal.
    expect(
      (services['mcp-servers'] as { remove: ReturnType<typeof vi.fn> }).remove
    ).toHaveBeenCalledWith('server-1', expect.objectContaining({ provider: undefined }));
  });

  it('takes back the server it created when the attach is refused', async () => {
    const { app, services, removed } = buildApp(CURATED);
    (
      services['/sessions/:id/mcp-servers'] as { create: ReturnType<typeof vi.fn> }
    ).create.mockRejectedValue(new Error('forbidden'));

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /forbidden/
    );
    expect(removed).toEqual(['server-1']);
  });

  it('leaves a reused install alone when a later step fails', async () => {
    const existing = installOf();
    const { app, services, removed } = buildApp(CURATED, [existing]);
    (services.sessions as { create: ReturnType<typeof vi.fn> }).create.mockRejectedValue(
      new Error('branch not found')
    );

    await expect(createMCPCatalogConnectService(app).create(request, params)).rejects.toThrow(
      /branch not found/
    );
    expect(removed).toEqual([]);
  });
});
