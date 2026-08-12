/**
 * The write side of private MCP servers: who may create, change, and delete a
 * server row, and what ownership the row ends up with.
 */

import type { AuthenticatedParams, MCPMemberPolicy, MCPServer, UserID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeMcpServerWrite,
  isMcpServerUsableByCaller,
  isSessionMcpServerLinkVisibleToCaller,
  loadMcpServerForCaller,
} from './mcp-server-authorization.js';

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

  it('stamps the creator as owner and the session reach under allow_private_only', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_private_only');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
        method: 'create',
        data: remoteCreate,
      })
    ).resolves.toEqual({ owner_user_id: ALICE, scope: 'session' });
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
    ).resolves.toEqual({
      owner_user_id: ALICE,
      scope: 'session',
      catalog_entry_name: 'com.linear/linear',
    });
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

/**
 * Below member is not "a member whose policy happens to be permissive".
 *
 * The four `mcp-servers` write verbs used to be gated on ADMIN by a role hook.
 * Routing them through this authorizer instead replaced that gate with a policy
 * gate, and a policy gate only knows admin-from-everyone-else — so every role
 * beneath member fell into the member path and inherited whatever the tenant's
 * `mcp_member_policy` grants. `viewer` is a real role ("Read-only access"), so
 * a read-only account could configure a server, and under `allow_crud` an
 * unowned one that every session in the tenant can then reach.
 *
 * This is currently unreachable over HTTP for an unrelated reason — a viewer
 * cannot authenticate at all, because the local strategy reads the user back
 * through a `users.get` gated at member. That is a separate bug, and one that
 * will be fixed; it is not a gate this rule may lean on. So the check lives
 * here, where the decision is actually made, and the tests synthesize the
 * identity rather than logging in.
 */
describe('authorizeMcpServerWrite refuses below-member roles', () => {
  beforeEach(() => {
    resolveMcpMemberPolicy.mockReset();
  });

  const WRITES = [
    { method: 'create' as const, data: remoteCreate },
    { method: 'update' as const, data: remoteCreate, existing: serverOwnedBy(ALICE) },
    { method: 'patch' as const, data: remoteCreate, existing: serverOwnedBy(ALICE) },
    { method: 'remove' as const, existing: serverOwnedBy(ALICE) },
  ];

  // Both permissive values: `use_existing_only` refuses everyone below admin
  // anyway, so it would pass with or without the fix and proves nothing.
  for (const policy of ['allow_private_only', 'allow_crud'] as const) {
    for (const write of WRITES) {
      it(`refuses a viewer ${write.method} under ${policy}`, async () => {
        resolveMcpMemberPolicy.mockResolvedValue(policy);

        await expect(
          authorizeMcpServerWrite(db, paramsFor(ALICE, 'viewer'), write)
        ).rejects.toThrow(/member access/i);
      });
    }

    it(`still lets a member create under ${policy}`, async () => {
      resolveMcpMemberPolicy.mockResolvedValue(policy);

      await expect(
        authorizeMcpServerWrite(db, paramsFor(ALICE, 'member'), {
          method: 'create',
          data: remoteCreate,
        })
      ).resolves.toBeDefined();
    });
  }

  // `normalizeRole` answers MEMBER for an absent role, so a check written as
  // `hasMinimumRole(user.role, MEMBER)` alone would admit a params object that
  // carries no role at all. Fail closed on the raw value instead.
  it('refuses a caller carrying no role rather than reading it as a member', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_crud');
    const roleless = {
      provider: 'rest',
      user: { user_id: ALICE },
    } as unknown as AuthenticatedParams;

    await expect(
      authorizeMcpServerWrite(db, roleless, { method: 'create', data: remoteCreate })
    ).rejects.toThrow(/member access/i);
  });

  it('refuses an unrecognised role rather than ranking it as a member', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'guest'), {
        method: 'create',
        data: remoteCreate,
      })
    ).rejects.toThrow(/member access/i);
  });

  it('decides before the policy is read, so the refusal does not depend on it', async () => {
    resolveMcpMemberPolicy.mockResolvedValue('allow_crud');

    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'viewer'), {
        method: 'create',
        data: remoteCreate,
      })
    ).rejects.toThrow(/member access/i);
    expect(resolveMcpMemberPolicy).not.toHaveBeenCalled();
  });

  it('leaves the legacy owner alias above the bar', async () => {
    await expect(
      authorizeMcpServerWrite(db, paramsFor(ALICE, 'owner'), {
        method: 'create',
        data: { transport: 'stdio' },
      })
    ).resolves.toEqual({});
    expect(resolveMcpMemberPolicy).not.toHaveBeenCalled();
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

const server = (owner_user_id?: string) =>
  ({ mcp_server_id: 'server-id', owner_user_id }) as unknown as MCPServer;

describe('isMcpServerUsableByCaller', () => {
  it('allows shared servers and the owner, but not another member', () => {
    expect(
      isMcpServerUsableByCaller(server(), {
        provider: 'rest',
        user: { user_id: 'user-a' },
      } as never)
    ).toBe(true);
    expect(
      isMcpServerUsableByCaller(server('user-a'), {
        provider: 'rest',
        user: { user_id: 'user-a' },
      } as never)
    ).toBe(true);
    expect(
      isMcpServerUsableByCaller(server('user-a'), {
        provider: 'rest',
        user: { user_id: 'user-b' },
      } as never)
    ).toBe(false);
  });

  it('allows admins and trusted internal callers', () => {
    expect(
      isMcpServerUsableByCaller(server('user-a'), {
        provider: 'rest',
        user: { user_id: 'user-b', role: 'admin' },
      } as never)
    ).toBe(true);
    expect(isMcpServerUsableByCaller(server('user-a'), undefined)).toBe(true);
  });
});

describe('isSessionMcpServerLinkVisibleToCaller', () => {
  const member = (user_id: string) => ({ provider: 'rest', user: { user_id } }) as never;

  it('hides a session creator private attachment from a collaborator', () => {
    const row = { owner_user_id: 'creator', session_created_by: 'creator' };
    expect(isSessionMcpServerLinkVisibleToCaller(row, member('collaborator'))).toBe(false);
    expect(isSessionMcpServerLinkVisibleToCaller(row, member('creator'))).toBe(true);
    expect(
      isSessionMcpServerLinkVisibleToCaller(
        { owner_user_id: 'foreign', session_created_by: 'creator' },
        member('creator')
      )
    ).toBe(false);
  });

  it('keeps shared links visible and allows admin/control-plane callers', () => {
    const row = { owner_user_id: null, session_created_by: 'creator' };
    expect(isSessionMcpServerLinkVisibleToCaller(row, member('collaborator'))).toBe(true);
    expect(
      isSessionMcpServerLinkVisibleToCaller(
        { owner_user_id: 'creator', session_created_by: 'creator' },
        { provider: 'rest', user: { user_id: 'admin', role: 'admin' } } as never
      )
    ).toBe(true);
    expect(
      isSessionMcpServerLinkVisibleToCaller(
        { owner_user_id: 'creator', session_created_by: 'creator' },
        undefined
      )
    ).toBe(true);
  });
});
