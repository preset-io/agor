/**
 * What a demotion takes away, and what it deliberately does not.
 *
 * `owner_user_id` is stamped when a server is configured and nothing revisits
 * it when a user's role changes, so every MCP surface that admits "the owner of
 * this row" kept admitting a user after they were demoted to `viewer`. For
 * reading a server one owns that is arguably right — ownership is a durable
 * grant. For starting an OAuth flow, exchanging the code, refreshing the grant,
 * or re-probing the server on its stored credential it is not: those issue new
 * capability, which a read-only account may not acquire.
 *
 * So this drives the real registration (`registerMcpCapabilityRoleFloor`, the
 * same call `register-services.ts` makes) over the real service paths, with a
 * real user row demoted in a real database, and reads the role back out of the
 * database the way the auth strategy does rather than trusting the role the
 * caller's params claim.
 *
 * The other half is as important: the read and session-resolution behaviour is
 * asserted *unchanged* here, so the line is visibly where it was drawn on
 * purpose rather than wherever the last edit left it.
 */

import { createDatabaseAsync, runMigrations, UsersRepository } from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import { isMCPServerUsableInSession } from '@agor/core/mcp';
import type { AuthenticatedParams, MCPServer, User, UserID, UserRole } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  isMcpServerUsableByCaller,
  MCP_CAPABILITY_ISSUING_SERVICE_PATHS,
  registerMcpCapabilityRoleFloor,
} from '../utils/mcp-server-authorization.js';

/**
 * The surfaces this change deliberately leaves open, named here so removing one
 * from the list is a decision somebody has to make in this file rather than a
 * side effect of editing the other one.
 */
const DELIBERATELY_UNGATED = [
  // Revocation. Refusing a demoted user the ability to drop their own grant
  // would strand the credential this change exists to contain.
  'mcp-servers/oauth-disconnect',
  // Reads of the caller's own state.
  'mcp-servers/oauth-status',
  'mcp-servers/oauth-attempt-status',
  // Vends a bearer for an already-issued grant to the executor running a
  // session, under a session token or service account rather than a user role.
  'mcp-servers/oauth-auth-headers',
];

async function buildDaemon(initialRole: UserRole = 'member') {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const users = new UsersRepository(rawDb);

  const user = (await users.create({
    email: 'bob@agor.live',
    name: 'Bob',
    role: initialRole,
  })) as User;

  // A server Bob owns, configured while he still could. The row outlives the
  // role that produced it, which is the whole premise.
  const server = {
    mcp_server_id: 'server-1' as MCPServer['mcp_server_id'],
    owner_user_id: user.user_id,
    transport: 'http',
    scope: 'session',
  } as unknown as MCPServer;

  const app = feathers();
  // Stand-ins for the endpoint bodies: what is under test is whether the
  // caller reaches them at all, and a spy states that more plainly than a
  // network probe would.
  const handlers = new Map<string, ReturnType<typeof vi.fn>>();
  for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
    const handler = vi.fn(async () => ({ success: true }));
    handlers.set(path, handler);
    app.use(path, { create: handler } as never);
  }
  registerMcpCapabilityRoleFloor(app);

  /** Params as a REST request arrives with them, carrying the *stored* role. */
  const paramsForStoredRole = async (): Promise<AuthenticatedParams> => {
    const current = await users.findById(user.user_id);
    return {
      provider: 'rest',
      authenticated: true,
      user: { user_id: user.user_id, role: current?.role },
    } as unknown as AuthenticatedParams;
  };

  return {
    user,
    server,
    handlers,
    demoteTo: (role: UserRole) => users.update(user.user_id, { role }),
    paramsForStoredRole,
    call: async (path: string) =>
      app.service(path).create({} as never, (await paramsForStoredRole()) as never),
  };
}

describe('MCP capability follows current role, not ownership alone', () => {
  it('refuses every credential-issuing surface to an owner demoted to viewer', async () => {
    const { demoteTo, call, handlers } = await buildDaemon('member');
    await demoteTo('viewer');

    const outcomes = await Promise.all(
      MCP_CAPABILITY_ISSUING_SERVICE_PATHS.map(async (path) => {
        const refusal = await call(path).then(
          () => 'allowed',
          (error: Error & { code?: number }) => `${error.code} ${error.message}`
        );
        return [path, refusal] as const;
      })
    );

    expect(Object.fromEntries(outcomes)).toEqual(
      Object.fromEntries(
        MCP_CAPABILITY_ISSUING_SERVICE_PATHS.map((path) => [
          path,
          '403 You need member access to connect and authorize MCP servers',
        ])
      )
    );

    // Refused in front of the endpoint, not inside it: none of these bodies
    // should have run far enough to reach a provider or touch the row.
    for (const [path, handler] of handlers) {
      expect(handler, `${path} body ran`).not.toHaveBeenCalled();
    }
  });

  it('leaves the same surfaces open while the owner is still a member', async () => {
    const { call, handlers } = await buildDaemon('member');

    for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
      await expect(call(path), path).resolves.toEqual({ success: true });
      expect(handlers.get(path)).toHaveBeenCalledTimes(1);
    }
  });

  it('takes effect on the next request, without waiting for a re-login', async () => {
    // The floor reads `params.user.role`, which is not a JWT claim: the token
    // carries only the subject, and `ServiceJWTStrategy.getEntity` loads the
    // user row from the database on every authenticated request. So a demotion
    // lands on the next call rather than whenever the session's token expires,
    // and there is no stale-credential window to close separately.
    //
    // `paramsForStoredRole` re-reads the row for that reason — it models what
    // the strategy does, so the refusals above are about the stored role rather
    // than about params this test handed itself.
    const { call, demoteTo, paramsForStoredRole, handlers } = await buildDaemon('member');
    const path = MCP_CAPABILITY_ISSUING_SERVICE_PATHS[0];

    await expect(call(path)).resolves.toEqual({ success: true });

    await demoteTo('viewer');

    expect((await paramsForStoredRole()).user?.role).toBe('viewer');
    await expect(call(path)).rejects.toThrow(/member access/i);
    // The one call from before the demotion, and nothing after it.
    expect(handlers.get(path)).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller carrying no role at all', async () => {
    // `hasMinimumRole(undefined, MEMBER)` is true — `normalizeRole` answers
    // MEMBER for an absent value — so the generic role hook would admit exactly
    // this caller. The MCP floor decides on the raw role for that reason.
    const { call } = await buildDaemon('member');
    const app = feathers();
    const handler = vi.fn(async () => ({ success: true }));
    for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
      app.use(path, { create: handler } as never);
    }
    registerMcpCapabilityRoleFloor(app);

    for (const roleless of [undefined, '', null]) {
      await expect(
        app.service(MCP_CAPABILITY_ISSUING_SERVICE_PATHS[0]).create(
          {} as never,
          {
            provider: 'rest',
            authenticated: true,
            user: { user_id: 'u1', role: roleless },
          } as never
        )
      ).rejects.toThrow(/member access/i);
    }
    expect(handler).not.toHaveBeenCalled();
    // The fixture's own member still gets through, so the above is about the
    // role rather than about the app being broken.
    await expect(call(MCP_CAPABILITY_ISSUING_SERVICE_PATHS[0])).resolves.toBeDefined();
  });

  it('leaves internal daemon calls and executor service accounts alone', async () => {
    const { demoteTo } = await buildDaemon('member');
    await demoteTo('viewer');

    const app = feathers();
    const handler = vi.fn(async () => ({ success: true }));
    for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
      app.use(path, { create: handler } as never);
    }
    registerMcpCapabilityRoleFloor(app);
    const path = MCP_CAPABILITY_ISSUING_SERVICE_PATHS[0];

    // No provider: a daemon-to-daemon call, which carries no role to floor.
    await expect(app.service(path).create({} as never)).resolves.toEqual({ success: true });

    // The executor's service account, likewise.
    await expect(
      app.service(path).create(
        {} as never,
        {
          provider: 'rest',
          user: { user_id: 'svc', role: 'viewer', _isServiceAccount: true },
        } as never
      )
    ).resolves.toEqual({ success: true });
  });
});

describe('what demotion deliberately does not take away', () => {
  it('still lets a demoted owner read the server they own', async () => {
    // Ownership as a durable grant. Changing this would change which servers
    // resolve into already-running sessions, which is a separate decision from
    // who may issue new credentials, and one #2301 leaves open.
    const { server, paramsForStoredRole, demoteTo } = await buildDaemon('member');
    await demoteTo('viewer');

    expect(isMcpServerUsableByCaller(server, await paramsForStoredRole())).toBe(true);
  });

  it('still resolves that server into the sessions its owner created', async () => {
    const { user, server, demoteTo } = await buildDaemon('member');
    await demoteTo('viewer');

    expect(isMCPServerUsableInSession(server, { created_by: user.user_id as UserID })).toBe(true);
  });

  it('keeps another user out of it regardless of role', async () => {
    const { server } = await buildDaemon('member');

    expect(
      isMcpServerUsableByCaller(server, {
        provider: 'rest',
        user: { user_id: 'someone-else', role: 'member' },
      } as unknown as AuthenticatedParams)
    ).toBe(false);
  });

  it('leaves revocation, status reads, and executor token vending ungated', () => {
    for (const path of DELIBERATELY_UNGATED) {
      expect(MCP_CAPABILITY_ISSUING_SERVICE_PATHS as readonly string[]).not.toContain(path);
    }
  });
});
