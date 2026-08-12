/**
 * A session is stamped with its creator's `unix_username` at creation, and in
 * `delegated`/`strict` that stamp is the OS identity the executor runs as. If
 * an admin later changes the user's `unix_username`, the stamp names an
 * identity the user no longer owns and the SDK state sits in a home directory
 * the instance cannot read, so the prompt has to be refused.
 *
 * That property comes from `unix_user_mode` alone, but `validateSessionUnixUsername`
 * used to be registered only inside the `branch_rbac` spread — so an
 * open-access instance running `strict` kept executing prompts as the stale
 * user, while the same request was refused once RBAC was on.
 *
 * These tests run the before-create chains that `registerHooks` actually
 * installs, rather than calling the validator directly: the bug was never in
 * the validator, it was in whether the validator was reached.
 */

import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks';

type RegisteredHook = (context: HookContext) => unknown;

const SESSION_ID = '00000000-0000-7000-8000-000000000001';
const BRANCH_ID = '00000000-0000-7000-8000-000000000002';
const CREATOR_ID = '00000000-0000-7000-8000-000000000003';

interface Harness {
  chains: Map<string, RegisteredHook[]>;
  sessionReads: number;
  userReads: number;
}

/**
 * Register the real hooks against a recording stand-in for the Feathers app,
 * with session/user stubs wired in so the captured chain can be executed.
 */
const buildHarness = (options: {
  branchRbac: boolean;
  unixUserMode: 'simple' | 'delegated' | 'insulated' | 'strict';
  /** Creator's `unix_username` today; the session is always stamped 'alice'. */
  creatorUnixUsername: string | null;
}): Harness => {
  const harness: Harness = { chains: new Map(), sessionReads: 0, userReads: 0 };

  const app = {
    service(path: string) {
      return {
        // `strict` also subscribes to service events to materialize Unix
        // groups; nothing here exercises that path.
        on() {},
        hooks(hooks: { before?: Record<string, RegisteredHook[]> }) {
          const key = path.replace(/^\//, '');
          for (const [method, chain] of Object.entries(hooks?.before ?? {})) {
            const mapKey = `${key}.${method}`;
            harness.chains.set(mapKey, [...(harness.chains.get(mapKey) ?? []), ...(chain ?? [])]);
          }
        },
      };
    },
    use() {},
    publish() {},
  };

  const sessionsService = {
    async get(sessionId: string) {
      harness.sessionReads += 1;
      return {
        session_id: sessionId,
        branch_id: BRANCH_ID,
        created_by: CREATOR_ID,
        unix_username: 'alice',
      };
    },
  };

  const usersRepository = {
    async findById(userId: string) {
      harness.userReads += 1;
      return { user_id: userId, unix_username: options.creatorUnixUsername };
    },
  };

  registerHooks({
    db: {} as RegisterHooksContext['db'],
    app: app as unknown as RegisterHooksContext['app'],
    config: {
      database: { dialect: 'postgresql' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'unix-identity-drift-test' },
      execution: { branch_rbac: options.branchRbac, unix_user_mode: options.unixUserMode },
    } as RegisterHooksContext['config'],
    jwtSecret: 'unix-identity-drift-test-secret',
    deployment: { mode: 'standalone' },
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: sessionsService as unknown as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository: {} as RegisterHooksContext['branchRepository'],
    usersRepository: usersRepository as unknown as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
  });

  return harness;
};

/** An external prompt write, as the REST/socket transports deliver it. */
const makeContext = (path: 'messages' | 'tasks'): HookContext =>
  ({
    path,
    method: 'create',
    data:
      path === 'messages'
        ? { session_id: SESSION_ID, role: 'user', content: 'ship it' }
        : { session_id: SESSION_ID, full_prompt: 'ship it' },
    params: {
      provider: 'rest',
      user: { user_id: CREATOR_ID, role: 'member' },
      query: {},
    },
  }) as unknown as HookContext;

const runCreateChain = async (harness: Harness, path: 'messages' | 'tasks'): Promise<void> => {
  const chain = harness.chains.get(`${path}.create`);
  if (!chain?.length) throw new Error(`no before.create hooks captured for ${path}`);
  let context = makeContext(path);
  for (const hook of chain) {
    context = ((await hook(context)) as HookContext) ?? context;
  }
};

const PROMPT_WRITES = ['messages', 'tasks'] as const;
const IDENTITY_MODES = ['delegated', 'strict'] as const;

describe.each(PROMPT_WRITES)('%s.create — session unix identity drift', (path) => {
  describe.each(IDENTITY_MODES)('unix_user_mode: %s, branch_rbac: false', (unixUserMode) => {
    it('refuses a prompt whose creator has been renamed since session creation', async () => {
      const harness = buildHarness({
        branchRbac: false,
        unixUserMode,
        creatorUnixUsername: 'alice-renamed',
      });

      await expect(runCreateChain(harness, path)).rejects.toThrow(
        /Session security context has changed/
      );
      expect(harness.userReads).toBe(1);
    });

    it('allows a prompt while the creator still owns the stamped identity', async () => {
      const harness = buildHarness({
        branchRbac: false,
        unixUserMode,
        creatorUnixUsername: 'alice',
      });

      await expect(runCreateChain(harness, path)).resolves.toBeUndefined();
      expect(harness.sessionReads).toBe(1);
      expect(harness.userReads).toBe(1);
    });
  });

  it('still refuses under branch_rbac with a Unix mode that stamps nothing', async () => {
    const harness = buildHarness({
      branchRbac: true,
      unixUserMode: 'simple',
      creatorUnixUsername: 'alice-renamed',
    });

    await expect(runCreateChain(harness, path)).rejects.toThrow(
      /Session security context has changed/
    );
  });

  /**
   * The inverse pin. Widening the guard costs one session read plus one user
   * read per prompt, and the default deployment must not pay either.
   */
  it('reads neither session nor creator when RBAC and per-user identity are both off', async () => {
    const harness = buildHarness({
      branchRbac: false,
      unixUserMode: 'simple',
      creatorUnixUsername: 'alice-renamed',
    });

    await expect(runCreateChain(harness, path)).resolves.toBeUndefined();
    expect(harness.sessionReads).toBe(0);
    expect(harness.userReads).toBe(0);
  });
});
