/**
 * The MCP caller-trust prelude, driven through the chains `registerHooks`
 * actually installs.
 *
 * Seven MCP authorization sites open with the same prelude — skip internal
 * calls, read `params.user`, exempt service accounts — but they disagreed on
 * what "authenticated with no `params.user`" means: the authorizer utilities
 * denied, while these two hooks passed the request straight through. On `find`
 * that meant the query was left unscoped, so the caller would have received
 * every MCP server in the tenant.
 *
 * `requireAuth` populates `params.user` ahead of both hooks today, so the
 * divergence was latent rather than live. These assert it is now closed at the
 * hook itself, and — the part that matters — that closing it did not take the
 * genuine service-account exemption down with it, since both cases used to
 * share one `||` branch.
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
        hooks(hooks: {
          before?: Record<string, RegisteredHook[]>;
          after?: Record<string, RegisteredHook[]>;
        }) {
          const key = path.replace(/^\//, '');
          for (const [phase, methods] of [
            ['before', hooks?.before ?? {}],
            ['after', hooks?.after ?? {}],
          ] as const) {
            for (const [method, chain] of Object.entries(methods)) {
              const mapKey = `${key}.${phase}.${method}`;
              chains.set(mapKey, [...(chains.get(mapKey) ?? []), ...(chain ?? [])]);
            }
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
      multi_tenancy: { mode: 'static', static_tenant_id: 'mcp-caller-trust-test' },
    } as RegisterHooksContext['config'],
    jwtSecret: 'mcp-caller-trust-test-secret',
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

const chainFor = (key: string): RegisteredHook[] => {
  const chain = captureChains().get(key);
  if (!chain?.length) throw new Error(`no hooks captured for ${key}`);
  return chain;
};

const runChain = async (chain: RegisteredHook[], context: HookContext): Promise<HookContext> => {
  let current = context;
  for (const hook of chain) {
    current = ((await hook(current)) as HookContext) ?? current;
  }
  return current;
};

/** Authenticated transport, but no resolved user — the divergent case. */
const anonymousFind = (): HookContext =>
  ({
    path: 'mcp-servers',
    method: 'find',
    params: { provider: 'rest', query: {} },
  }) as unknown as HookContext;

const serviceAccountFind = (): HookContext =>
  ({
    path: 'mcp-servers',
    method: 'find',
    params: {
      provider: 'rest',
      user: { user_id: 'svc-1', role: 'member', _isServiceAccount: true },
      query: {},
    },
  }) as unknown as HookContext;

const anonymousGet = (): HookContext =>
  ({
    path: 'mcp-servers',
    method: 'get',
    id: 'server-1',
    result: { mcp_server_id: 'server-1', owner_user_id: 'someone-else' },
    params: { provider: 'rest', query: {} },
  }) as unknown as HookContext;

const serviceAccountGet = (): HookContext =>
  ({
    path: 'mcp-servers',
    method: 'get',
    id: 'server-1',
    result: { mcp_server_id: 'server-1', owner_user_id: 'someone-else' },
    params: {
      provider: 'rest',
      user: { user_id: 'svc-1', role: 'member', _isServiceAccount: true },
      query: {},
    },
  }) as unknown as HookContext;

describe('MCP caller-trust prelude', () => {
  it('refuses a find carrying no user instead of leaving the query unscoped', async () => {
    await expect(runChain(chainFor('mcp-servers.before.find'), anonymousFind())).rejects.toThrow(
      /authentication required/i
    );
  });

  it('refuses a get carrying no user instead of returning the row', async () => {
    await expect(runChain(chainFor('mcp-servers.after.get'), anonymousGet())).rejects.toThrow(
      /authentication required/i
    );
  });

  it('still exempts a genuine service account on find', async () => {
    const context = await runChain(chainFor('mcp-servers.before.find'), serviceAccountFind());
    expect(context.params.query?.usableByUserId).toBeUndefined();
  });

  it('still exempts a genuine service account on get', async () => {
    const context = await runChain(chainFor('mcp-servers.after.get'), serviceAccountGet());
    expect(context.result).toMatchObject({ mcp_server_id: 'server-1' });
  });
});
