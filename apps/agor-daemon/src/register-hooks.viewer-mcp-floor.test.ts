/**
 * The MCP configuration write floor, driven through the chain `registerHooks`
 * actually installs.
 *
 * `authorizeMcpServerWrite` has refused below-member roles since #2240, but that
 * could only ever be asserted against the authorizer in isolation: a viewer
 * could not authenticate at all, because the local strategy read the user back
 * through a `users.get` gated at member. #2322 fixed that, and in doing so also
 * removed the blanket `requireMinimumRole(ROLES.MEMBER)` from several `all`
 * chains — `mcp-servers` now carries only `[typedValidateQuery, requireAuth]`.
 *
 * So the floor's enforcement rests entirely on the write hook being registered
 * on every write verb. That is what this asserts, by running the registered
 * chain with a viewer identity rather than by calling the authorizer.
 */

import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks';

type RegisteredHook = (context: HookContext) => unknown;

const captureChains = (): Map<string, RegisteredHook[]> => {
  const chains = new Map<string, RegisteredHook[]>();
  const app = {
    service(path: string) {
      return {
        on() {},
        hooks(hooks: { before?: Record<string, RegisteredHook[]> }) {
          const key = path.replace(/^\//, '');
          for (const [method, chain] of Object.entries(hooks?.before ?? {})) {
            const mapKey = `${key}.${method}`;
            chains.set(mapKey, [...(chains.get(mapKey) ?? []), ...(chain ?? [])]);
          }
        },
      };
    },
    use() {},
    publish() {},
  };

  registerHooks({
    db: {} as RegisterHooksContext['db'],
    app: app as unknown as RegisterHooksContext['app'],
    config: {
      database: { dialect: 'postgresql' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'viewer-mcp-floor-test' },
    } as RegisterHooksContext['config'],
    jwtSecret: 'viewer-mcp-floor-test-secret',
    deployment: { mode: 'standalone' },
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: {} as RegisterHooksContext['branchRepository'],
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
  });

  return chains;
};

/** A logged-in viewer creating an MCP server — impossible to express before #2322. */
const viewerCreate = (): HookContext =>
  ({
    path: 'mcp-servers',
    method: 'create',
    data: {
      name: 'exfil',
      transport: 'http',
      url: 'https://example.invalid/mcp',
    },
    params: {
      provider: 'rest',
      user: { user_id: 'viewer-1', role: 'viewer' },
      query: {},
    },
  }) as unknown as HookContext;

describe('MCP write floor for a logged-in viewer', () => {
  it('registers the write authorizer on every mcp-servers write verb', () => {
    const chains = captureChains();

    for (const verb of ['create', 'update', 'patch', 'remove']) {
      expect(chains.get(`mcp-servers.${verb}`)?.length, `mcp-servers.${verb}`).toBeGreaterThan(0);
    }
  });

  it('refuses a viewer through the registered create chain', async () => {
    const chains = captureChains();
    const chain = chains.get('mcp-servers.create');
    if (!chain?.length) throw new Error('no before.create hooks captured for mcp-servers');

    let context = viewerCreate();
    const run = async () => {
      for (const hook of chain) {
        context = ((await hook(context)) as HookContext) ?? context;
      }
    };

    // The role floor is checked before any policy or database work, so this
    // refuses without the stub db being touched.
    await expect(run()).rejects.toThrow(/member access/i);
  });
});
