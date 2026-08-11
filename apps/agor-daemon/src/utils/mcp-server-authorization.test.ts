/**
 * The write side of private MCP servers: who may create, change, and delete a
 * server row, and what ownership the row ends up with.
 */

import type { AuthenticatedParams, MCPMemberPolicy, MCPServer, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeMcpServerWrite, loadMcpServerForCaller } from './mcp-server-authorization.js';

const { resolveMcpMemberPolicy, findById } = vi.hoisted(() => ({
  resolveMcpMemberPolicy: vi.fn<() => Promise<MCPMemberPolicy>>(),
  findById: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@agor/core/db', () => ({
  MCPServerRepository: class {
    findById = findById;
  },
  resolveMcpMemberPolicy,
}));

const ALICE = '00000000-0000-7000-8000-00000000a11c' as UserID;
const BOB = '00000000-0000-7000-8000-00000000b0b0' as UserID;

// The authorizer only forwards this to the mocked policy resolver.
const db = {} as never;

function paramsFor(userId: UserID, role: string): AuthenticatedParams {
  return {
    provider: 'rest',
    user: { user_id: userId, role },
  } as unknown as AuthenticatedParams;
}

function serverOwnedBy(
  owner?: UserID
): Pick<MCPServer, 'mcp_server_id' | 'owner_user_id' | 'transport'> {
  return {
    mcp_server_id: 'server-1' as MCPServer['mcp_server_id'],
    owner_user_id: owner,
    transport: 'http',
  };
}

const remoteCreate = { transport: 'http' as const };

describe('authorizeMcpServerWrite', () => {
  beforeEach(() => {
    resolveMcpMemberPolicy.mockReset();
  });

  it('leaves internal and service-account calls alone', async () => {
    await expect(
      authorizeMcpServerWrite(db, undefined, { method: 'create', data: { transport: 'stdio' } })
    ).resolves.toEqual({});

    const serviceAccount = {
      provider: 'rest',
      user: { user_id: ALICE, role: 'member', _isServiceAccount: true },
    } as unknown as AuthenticatedParams;
    await expect(
      authorizeMcpServerWrite(db, serviceAccount, {
        method: 'create',
        data: { transport: 'stdio' },
      })
    ).resolves.toEqual({});
    expect(resolveMcpMemberPolicy).not.toHaveBeenCalled();
  });

  it('keeps the pre-marketplace behaviour by default', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('use_existing_only');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
        method: 'create',
        data: remoteCreate,
      })
    ).rejects.toThrow(/does not allow members to configure MCP servers/);
  });

  it('admins are unaffected by the policy', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('use_existing_only');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'admin'), {
        method: 'create',
        data: { transport: 'stdio' },
      })
    ).resolves.toEqual({});
    expect(resolveMcpMemberPolicy).not.toHaveBeenCalled();
  });

  it('stamps the creator as owner under allow_private_only', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_private_only');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
        method: 'create',
        data: remoteCreate,
      })
    ).resolves.toEqual({ owner_user_id: ALICE });
  });

  it('refuses to create a server owned by someone else', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
        method: 'create',
        data: { ...remoteCreate, owner_user_id: BOB },
      })
    ).rejects.toThrow(/owned by yourself/);
  });

  it('lets allow_crud members create a shared server', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
        method: 'create',
        data: remoteCreate,
      })
    ).resolves.toEqual({});
  });

  it.each(['allow_private_only', 'allow_crud'] as const)(
    'refuses stdio for members under %s',
    async (policy) => {
      resolveMcpMemberPolicy.mockResolvedValue(policy);

      await expect(
        authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
          method: 'create',
          data: { transport: 'stdio' },
        })
      ).rejects.toThrow(/Only admins can configure stdio MCP servers/);
    }
  );

  it('refuses a patch that would turn a member-owned server into stdio', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
        method: 'patch',
        existing: serverOwnedBy(ALICE),
        data: { transport: 'stdio' },
      })
    ).rejects.toThrow(/Only admins can configure stdio MCP servers/);
  });

  it.each(['patch', 'update', 'remove'] as const)(
    "refuses %s of another member's private server",
    async (method) => {
      resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

      await expect(
        authorizeMcpServerWrite(db, paramsFor(BOB, 'member'), {
          method,
          existing: serverOwnedBy(ALICE),
          data: method === 'remove' ? undefined : remoteCreate,
        })
      ).rejects.toThrow(/another user's private MCP server/);
    }
  );

  it('keeps allow_private_only members off shared servers', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_private_only');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
        method: 'patch',
        existing: serverOwnedBy(undefined),
        data: remoteCreate,
      })
    ).rejects.toThrow(/only allows members to manage their own private MCP servers/);
  });

  it.each(['member', 'admin'] as const)(
    'refuses to move ownership, even for a %s',
    async (role) => {
      resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

      await expect(
        authorizeMcpServerWrite(db, paramsFor(ALICE, role), {
          method: 'patch',
          existing: serverOwnedBy(ALICE),
          data: { ...remoteCreate, owner_user_id: BOB },
        })
      ).rejects.toThrow(/ownership cannot be changed/);
    }
  );

  it('accepts a payload that echoes a shared server\u2019s absent owner', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
        method: 'patch',
        existing: serverOwnedBy(undefined),
        data: { ...remoteCreate, owner_user_id: null },
      })
    ).resolves.toEqual({});
  });

  it('refuses to make a private server shared', async () => {
    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'admin'), {
        method: 'patch',
        existing: serverOwnedBy(ALICE),
        data: { ...remoteCreate, owner_user_id: null },
      })
    ).rejects.toThrow(/ownership cannot be changed/);
  });

  it.each(['member', 'admin'] as const)(
    'refuses a caller-supplied catalog stamp from a %s',
    async (role) => {
      resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

      // The registry name is printed on every card in the marketplace, so a
      // stamp anybody may submit is a claim anybody may fake — and connect
      // reuses a server by that claim. Provenance is recorded by the install
      // path or not at all, which is why an admin is refused too: it is not a
      // field an operator maintains, it is a fact about how the row got here.
      await expect(
        authorizeMcpServerWrite(db, paramsFor(ALICE, role), {
          method: 'create',
          data: { ...remoteCreate, catalog_entry_name: 'io.github.github/github-mcp-server' },
        })
      ).rejects.toThrow(/catalog provenance cannot be set/i);
    }
  );

  it.each(['patch', 'update'] as const)(
    'refuses a caller-supplied catalog stamp on %s',
    async (method) => {
      resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

      await expect(
        authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
          method,
          existing: serverOwnedBy(ALICE),
          data: { ...remoteCreate, catalog_entry_name: 'io.github.github/github-mcp-server' },
        })
      ).rejects.toThrow(/catalog provenance cannot be set/i);
    }
  );

  it('stamps provenance when the marketplace install path names the entry', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_private_only');

    const installParams = {
      ...paramsFor(ALICE, 'member'),
      mcpCatalogInstall: { entry_name: 'com.linear/linear' },
    } as AuthenticatedParams;

    await expect(
      authorizeMcpServerWrite(db, installParams, { method: 'create', data: remoteCreate })
    ).resolves.toEqual({ owner_user_id: ALICE, catalog_entry_name: 'com.linear/linear' });
  });

  it.each([
    ['allow_crud', 'member'],
    ['allow_crud', 'admin'],
    ['allow_private_only', 'admin'],
  ] as const)(
    'gives a marketplace install to its installer under %s, at role %s',
    async (policy, role) => {
      resolveMcpMemberPolicy.mockResolvedValue(policy);

      const installParams = {
        ...paramsFor(ALICE, role),
        mcpCatalogInstall: { entry_name: 'com.linear/linear' },
      } as AuthenticatedParams;

      // Without this the row lands unowned, and an unowned row is usable by
      // every user in the tenant — an install nobody asked to share.
      await expect(
        authorizeMcpServerWrite(db, installParams, { method: 'create', data: remoteCreate })
      ).resolves.toEqual({ owner_user_id: ALICE, catalog_entry_name: 'com.linear/linear' });
    }
  );

  it('leaves an internal caller free to record provenance directly', async () => {
    await expect(
      authorizeMcpServerWrite(db, undefined, {
        method: 'create',
        data: { ...remoteCreate, catalog_entry_name: 'com.linear/linear' },
      })
    ).resolves.toEqual({});
  });

  it('lets an owner change their own remote server', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_private_only');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
        method: 'patch',
        existing: serverOwnedBy(ALICE),
        data: remoteCreate,
      })
    ).resolves.toEqual({});
  });
});

describe('loadMcpServerForCaller', () => {
  beforeEach(() => {
    findById.mockReset();
  });

  it("hides another user's private server rather than forbidding it", async () => {
    findById.mockResolvedValue(serverOwnedBy(ALICE));

    await expect(
      loadMcpServerForCaller(db, 'server-1', paramsFor(BOB, 'member'))
    ).rejects.toMatchObject({ code: 404 });
  });

  it('lets the owner through', async () => {
    findById.mockResolvedValue(serverOwnedBy(ALICE));

    await expect(
      loadMcpServerForCaller(db, 'server-1', paramsFor(ALICE, 'member'))
    ).resolves.toMatchObject({ owner_user_id: ALICE });
  });

  it('lets any member reach a shared server, and admins reach anything', async () => {
    findById.mockResolvedValue(serverOwnedBy(undefined));
    await expect(
      loadMcpServerForCaller(db, 'server-1', paramsFor(BOB, 'member'))
    ).resolves.toBeDefined();

    findById.mockResolvedValue(serverOwnedBy(ALICE));
    await expect(
      loadMcpServerForCaller(db, 'server-1', paramsFor(BOB, 'admin'))
    ).resolves.toBeDefined();
  });

  it('reports a missing server as missing', async () => {
    findById.mockResolvedValue(null);

    await expect(
      loadMcpServerForCaller(db, 'server-1', paramsFor(ALICE, 'admin'))
    ).rejects.toMatchObject({ code: 404 });
  });
});
