/**
 * A session is stamped with its creator's `unix_username` at creation, and in
 * `delegated` mode that stamp is the execution-home key the external substrate uses. If
 * an admin later changes the user's `unix_username`, the stamp names an
 * identity the user no longer owns and the SDK state sits in a home directory
 * the instance cannot read, so the prompt has to be refused.
 *
 * That property comes from `unix_user_mode` alone, but `validateSessionUnixUsername`
 * used to be registered only inside the `branch_rbac` spread — so an
 * open-access instance running `delegated` kept executing prompts as the stale
 * user, while the same request was refused once RBAC was on.
 *
 * These tests run the before-create chains that `registerHooks` actually
 * installs, rather than calling the validator directly: the bug was never in
 * the validator, it was in whether the validator was reached.
 */

import {
  type HookContext,
  type MessageCreate,
  MessageRole,
  type SessionID,
} from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks';

type RegisteredHook = (context: HookContext) => unknown;

const SESSION_ID = '00000000-0000-7000-8000-000000000001' as SessionID;
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
  unixUserMode: 'simple' | 'sandbox' | 'delegated';
  sdkHomeScope?: 'execution_home' | 'branch';
  /** Creator's `unix_username` today; the session is always stamped 'alice'. */
  creatorUnixUsername: string | null;
}): Harness => {
  const harness: Harness = { chains: new Map(), sessionReads: 0, userReads: 0 };

  const app = {
    service(path: string) {
      return {
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
      return {
        session_id: sessionId,
        branch_id: BRANCH_ID,
        created_by: CREATOR_ID,
        unix_username: 'alice',
        sdk_home_scope: options.sdkHomeScope ?? 'execution_home',
      };
    },
  };

  const sessionsRepository = {
    async findById(sessionId: string) {
      harness.sessionReads += 1;
      return {
        session_id: sessionId,
        branch_id: BRANCH_ID,
        created_by: CREATOR_ID,
        unix_username: 'alice',
        sdk_home_scope: options.sdkHomeScope ?? 'execution_home',
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
    sessionsRepository: sessionsRepository as unknown as RegisterHooksContext['sessionsRepository'],
  });

  return harness;
};

/**
 * A running executor writing its own transcript. It authenticates with a
 * session token minted for the prompting user, so it is an ordinary user
 * identity on the wire and only the token payload marks it as executor-scoped.
 */
const executorAuthentication = (sessionId: string) => ({
  strategy: 'jwt',
  payload: {
    type: 'executor-session',
    purpose: 'executor-task',
    session_id: sessionId,
    task_id: '00000000-0000-7000-8000-000000000004',
  },
});

/** An external prompt write, as the REST/socket transports deliver it. */
const makeContext = (
  path: 'messages' | 'tasks',
  asExecutor: false | string = false
): HookContext => {
  const message = {
    session_id: SESSION_ID,
    type: 'user',
    role: MessageRole.USER,
    index: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    content_preview: 'ship it',
    content: 'ship it',
  } satisfies MessageCreate;

  return {
    path,
    method: 'create',
    data: path === 'messages' ? message : { session_id: SESSION_ID, full_prompt: 'ship it' },
    params: {
      provider: 'rest',
      user: { user_id: CREATOR_ID, role: 'member' },
      query: {},
      ...(asExecutor ? { authentication: executorAuthentication(asExecutor) } : {}),
    },
  } as unknown as HookContext;
};

const runCreateChain = async (
  harness: Harness,
  path: 'messages' | 'tasks',
  asExecutor: false | string = false
): Promise<void> => {
  const chain = harness.chains.get(`${path}.create`);
  if (!chain?.length) throw new Error(`no before.create hooks captured for ${path}`);
  let context = makeContext(path, asExecutor);
  for (const hook of chain) {
    context = ((await hook(context)) as HookContext) ?? context;
  }
};

const PROMPT_WRITES = ['messages', 'tasks'] as const;
const IDENTITY_MODES = ['delegated'] as const;

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

    it("ignores the creator's old stamp for a branch-scoped Session", async () => {
      const harness = buildHarness({
        branchRbac: false,
        unixUserMode,
        sdkHomeScope: 'branch',
        creatorUnixUsername: 'alice-renamed',
      });

      await expect(runCreateChain(harness, path)).resolves.toBeUndefined();
      expect(harness.sessionReads).toBe(1);
      expect(harness.userReads).toBe(0);
    });

    /**
     * A running executor writes its transcript over its own authenticated
     * transport, so it reaches this chain as a normal user. Holding it to the
     * check would cost two reads per transcript row and, once a rename landed
     * mid-task, would drop the rows of a process that is already running as the
     * stamped user — the launch it could have prevented is long past.
     */
    it('exempts the executor writing its own transcript', async () => {
      const harness = buildHarness({
        branchRbac: false,
        unixUserMode,
        creatorUnixUsername: 'alice-renamed',
      });

      await expect(runCreateChain(harness, path, SESSION_ID)).resolves.toBeUndefined();
      expect(harness.userReads).toBe(0);
    });

    /**
     * The exemption is bound to the task token's own session claim rather than
     * to "an executor credential is present", so a taskless command credential
     * or a token for another task cannot widen it.
     */
    it('does not exempt an executor token scoped to another session', async () => {
      const harness = buildHarness({
        branchRbac: false,
        unixUserMode,
        creatorUnixUsername: 'alice-renamed',
      });

      await expect(
        runCreateChain(harness, path, '00000000-0000-7000-8000-00000000000f')
      ).rejects.toThrow(/Session security context has changed/);
    });
  });

  /**
   * `simple` and `sandbox` never execute using the stamped home key —
   * so refusing on drift there would lock a user out of their own sessions over
   * an identity nothing runs as. RBAC still stamps sessions in those modes,
   * which is what used to make the check fire.
   */
  it('does not consult the creator under branch_rbac when the mode ignores the stamp', async () => {
    const harness = buildHarness({
      branchRbac: true,
      unixUserMode: 'simple',
      creatorUnixUsername: 'alice-renamed',
    });

    // The branch-permission half of the chain is deliberately not stubbed: this
    // asserts which hooks are registered, not what they decide. Pin the failure
    // it does produce, so stubbing `branchRepository` later cannot turn the
    // negative assertion below into a no-op against `undefined`.
    const failure = await runCreateChain(harness, path).catch((error: Error) => error);

    expect(String(failure)).toMatch(/is not a function/);
    expect(String(failure)).not.toMatch(/Session security context has changed/);
    expect(harness.userReads).toBe(0);
    expect(harness.sessionReads).toBe(1);
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
