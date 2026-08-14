/**
 * `update` is a first-class Feathers verb: every service registered through
 * DrizzleService inherits a working `update()` and, unless `app.use(...)`
 * narrows the exposed method list, Feathers routes `PUT /<service>/:id` to it.
 *
 * A hook block that names `create`/`patch`/`remove` but not `update` therefore
 * leaves whole-row replacement guarded by nothing but the service's `all`
 * chain — usually just `requireAuth`. These tests enumerate the hooks the real
 * registration code installs and fail when that shape reappears.
 */

import { feathers, feathersExpress, rest } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { type RegisterHooksContext, registerHooks } from './register-hooks';
import { ARTIFACTS_SERVICE_TRANSPORT_METHODS } from './services/artifacts';
import { GATEWAY_CHANNELS_SERVICE_TRANSPORT_METHODS } from './services/gateway-channels';
import { GROUPS_SERVICE_TRANSPORT_METHODS } from './services/groups';
import { KNOWLEDGE_GRAPH_SERVICE_TRANSPORT_METHODS } from './services/knowledge-graph';
import { SCHEDULES_SERVICE_TRANSPORT_METHODS } from './services/schedules';
import { TASKS_SERVICE_TRANSPORT_METHODS } from './services/tasks';
import { USERS_SERVICE_TRANSPORT_METHODS } from './services/users';
import { BRANCH_REMOVAL_VISIBILITY_PARAM } from './utils/realtime-publish';

type RegisteredHook = (context: HookContext) => unknown;
type CapturedHooks = { before: Record<string, RegisteredHook[]> };

/**
 * Run `registerHooks` against a recording stand-in for the Feathers app and
 * return the before-hook map per service path, for one RBAC mode.
 *
 * Several hook blocks spread their branch permission hooks in only when
 * `branchRbacEnabled` is true, so each mode is captured and asserted on its
 * own — see {@link RBAC_MODES}.
 */
const captureRegisteredHooks = (
  branchRbacEnabled: boolean,
  branchRepositoryOverride?: RegisterHooksContext['branchRepository']
): Map<string, CapturedHooks> => {
  const captured = new Map<string, CapturedHooks>();
  const visibleBranch = {
    branch_id: '00000000-0000-7000-8000-000000000001',
    others_can: 'view',
  };
  const app = {
    service(path: string) {
      return {
        hooks(hooks: { before?: Record<string, RegisteredHook[]> }) {
          const key = path.replace(/^\//, '');
          const entry = captured.get(key) ?? { before: {} };
          for (const [method, chain] of Object.entries(hooks?.before ?? {})) {
            entry.before[method] = [...(entry.before[method] ?? []), ...(chain ?? [])];
          }
          captured.set(key, entry);
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
      multi_tenancy: { mode: 'static', static_tenant_id: 'update-gating-test' },
    } as RegisterHooksContext['config'],
    jwtSecret: 'update-gating-test-secret',
    // The HA gates are `before.all` entries, so they cannot satisfy or defeat a
    // per-verb invariant; standalone keeps the captured map to the real hooks.
    deployment: { mode: 'standalone' },
    branchRbacEnabled,
    requireAuth: async (context) => context,
    superadminOpts: { allowSuperadmin: true },
    sessionsService: {} as RegisterHooksContext['sessionsService'],
    messagesService: {} as RegisterHooksContext['messagesService'],
    boardsService: undefined,
    branchRepository:
      branchRepositoryOverride ??
      ({
        findById: async () => visibleBranch,
        isOwner: async () => false,
        resolveUserPermission: async () => 'view',
      } as unknown as RegisterHooksContext['branchRepository']),
    usersRepository: {} as RegisterHooksContext['usersRepository'],
    sessionsRepository: {} as RegisterHooksContext['sessionsRepository'],
  });

  return captured;
};

describe('branch hard-delete realtime hook', () => {
  it('captures current authorized recipients before the branch and ACL rows are removed', async () => {
    const branchId = '00000000-0000-7000-8000-000000000001';
    const ownerId = '00000000-0000-7000-8000-0000000000ff';
    const branch = { branch_id: branchId, others_can: 'none' };
    const branchRepository = {
      findById: async () => branch,
      isOwner: async () => true,
      resolveUserPermission: async () => 'all',
      findRealtimeVisibilityBranch: async () => branch,
      findExplicitViewUserIds: async () => [ownerId, '00000000-0000-7000-8000-0000000000aa'],
    } as unknown as RegisterHooksContext['branchRepository'];
    const hooks = captureRegisteredHooks(true, branchRepository).get('branches')?.before;
    if (!hooks) throw new Error('branches registers no before hooks');
    const context = {
      path: 'branches',
      method: 'remove',
      id: branchId,
      params: {
        provider: 'rest',
        query: {},
        user: { user_id: ownerId, role: 'member' },
      },
    } as unknown as HookContext;

    for (const hook of hooks.remove ?? []) {
      await hook(context);
    }

    expect((context.params as Record<string, unknown>)[BRANCH_REMOVAL_VISIBILITY_PARAM]).toEqual({
      branchId,
      mode: 'explicitUsers',
      userIds: ['00000000-0000-7000-8000-0000000000aa', '00000000-0000-7000-8000-0000000000ff'],
    });
  });
});

/**
 * Both RBAC modes, kept separate on purpose.
 *
 * Merging them would let a verb gated only under `branchRbacEnabled: true`
 * satisfy the invariant while sitting wide open in the default mode, which is
 * exactly the shape these tests exist to catch.
 */
const RBAC_MODES = [
  { name: 'rbac disabled', branchRbacEnabled: false },
  { name: 'rbac enabled', branchRbacEnabled: true },
] as const;

const WRITE_METHODS = ['create', 'patch', 'remove'] as const;

const runCapturedHooks = async (
  captured: Map<string, CapturedHooks>,
  path: string,
  method: string,
  role: string
): Promise<HookContext> => {
  const hooks = captured.get(path)?.before;
  if (!hooks) throw new Error(`${path} registers no before hooks`);
  const context = {
    path,
    method,
    id: method === 'get' ? '00000000-0000-7000-8000-000000000001' : undefined,
    params: {
      provider: 'rest',
      query: {},
      user: { user_id: '00000000-0000-7000-8000-0000000000ff', role },
    },
  } as unknown as HookContext;

  for (const hook of [...(hooks.all ?? []), ...(hooks[method] ?? [])]) {
    await hook(context);
  }
  return context;
};

describe.each(RBAC_MODES)('viewer read access ($name)', ({ branchRbacEnabled }) => {
  const captured = captureRegisteredHooks(branchRbacEnabled);

  it.each([
    ['repos', 'find'],
    ['repos', 'get'],
    ['branches', 'find'],
    ['branches', 'get'],
    ['session-mcp-servers', 'find'],
    ['session-env-selections', 'find'],
  ])('allows viewers to use %s.%s', async (path, method) => {
    await expect(runCapturedHooks(captured, path, method, 'viewer')).resolves.toBeDefined();
  });

  if (branchRbacEnabled) {
    it('retains SQL branch visibility scoping for viewer branch finds', async () => {
      const context = await runCapturedHooks(captured, 'branches', 'find', 'viewer');
      expect(context.params).toMatchObject({
        _agorSqlBranchAccessUserId: '00000000-0000-7000-8000-0000000000ff',
      });
    });

    it('retains SQL session visibility scoping for viewer MCP assignment finds', async () => {
      const context = await runCapturedHooks(captured, 'session-mcp-servers', 'find', 'viewer');
      expect(context.params).toMatchObject({
        _agorSqlSessionAccessUserId: '00000000-0000-7000-8000-0000000000ff',
      });
    });
  }

  it.each([
    ['repos', 'create'],
    ['repos', 'patch'],
    ['repos', 'remove'],
    ['branches', 'create'],
    ['branches', 'patch'],
    ['branches', 'remove'],
    ['branches', 'updateEnvironment'],
    ['branches', 'ensureTeammateKnowledgeNamespace'],
  ])('keeps %s.%s restricted to members', async (path, method) => {
    await expect(runCapturedHooks(captured, path, method, 'viewer')).rejects.toMatchObject({
      name: 'Forbidden',
    });
  });
});

/**
 * Services that gate a write verb but deliberately leave `update` ungated,
 * because `update` is not reachable from any transport.
 *
 * Two distinct reasons appear below, and they are not interchangeable:
 *
 *  - a prose string — "no update method": the service object never defines one,
 *    so Feathers' default method list (which it filters by
 *    `typeof service[method]`) does not include it.
 *  - a methods array: `app.use(path, service, { methods: [...] })` in
 *    register-services.ts pins the exposed surface and leaves `update` out,
 *    whether or not the service object defines one. For a DrizzleService
 *    subclass the pin is the only thing keeping the inherited `update` off the
 *    wire.
 *
 * The second kind is the array register-services.ts actually spreads into
 * `app.use`, not prose describing it, and the "pinned methods list" test below
 * asserts it omits `update`. Adding `'update'` to one of those constants
 * therefore fails the suite at the constant, where the mistake is made — the
 * author has to gate the verb and drop the exemption.
 *
 * Prose entries are still unverified claims about the service object, so check
 * the source before adding one.
 */
const UPDATE_NOT_ROUTED: Record<string, string | readonly string[]> = {
  'admin/local-actions': 'no update method — the service exposes create only',
  'agentic-tool-presets': 'no update method — AgenticToolPresetsService is not a DrizzleService',
  'agentic-tool-settings':
    'no update method — TenantAgenticToolSettingsService is not a DrizzleService',
  artifacts: ARTIFACTS_SERVICE_TRANSPORT_METHODS,
  'artifacts/:id/console': 'no update method — custom route exposes create only',
  'artifacts/:id/runtime-response/:requestId':
    'no update method — custom route exposes create only',
  'artifacts/:id/sandpack-error': 'no update method — custom route exposes create only',
  'artifacts/:id/trust': 'no update method — custom route exposes create only',
  'gateway-channels': GATEWAY_CHANNELS_SERVICE_TRANSPORT_METHODS,
  groups: GROUPS_SERVICE_TRANSPORT_METHODS,
  'kb/graph': KNOWLEDGE_GRAPH_SERVICE_TRANSPORT_METHODS,
  'me/artifact-trust-grants': 'no update method — custom route exposes find and remove only',
  schedules: SCHEDULES_SERVICE_TRANSPORT_METHODS,
  tasks: TASKS_SERVICE_TRANSPORT_METHODS,
  users: USERS_SERVICE_TRANSPORT_METHODS,
};

/** Services gating a sibling write verb but leaving `update` on the `all` chain. */
const findUngated = (captured: Map<string, CapturedHooks>): string[] => {
  const ungated: string[] = [];
  for (const [path, hooks] of captured) {
    const gatedSiblings = WRITE_METHODS.filter((method) => hooks.before[method]?.length);
    if (gatedSiblings.length === 0) continue;
    if (hooks.before.update?.length) continue;
    if (path in UPDATE_NOT_ROUTED) continue;
    ungated.push(`${path} (gates ${gatedSiblings.join('/')})`);
  }
  return ungated;
};

describe.each(RBAC_MODES)('update-verb hook gating ($name)', ({ branchRbacEnabled }) => {
  const captured = captureRegisteredHooks(branchRbacEnabled);

  it('gates update wherever a sibling write verb is gated', () => {
    expect(
      findUngated(captured),
      'These services gate a write verb but leave PUT /<service>/:id on the `all` chain only. ' +
        'Give update the same gate its siblings have, or — if update is not routed — add it to ' +
        'UPDATE_NOT_ROUTED with the reason.'
    ).toEqual([]);
  });

  it('keeps every UPDATE_NOT_ROUTED entry earning its place', () => {
    for (const [path, reason] of Object.entries(UPDATE_NOT_ROUTED)) {
      const described = Array.isArray(reason) ? 'methods list omits update' : reason;
      expect(captured.has(path), `${path} no longer registers hooks — drop the exemption`).toBe(
        true
      );
      expect(
        captured.get(path)?.before.update ?? [],
        `${path} now gates update (${described}) — drop the exemption`
      ).toEqual([]);
    }
  });

  it('detects a dropped gate', () => {
    // The invariant above is only worth having if it fails when a gate goes
    // missing, so re-run it against a copy of the real registration with
    // boards' update chain deleted. boards is the least ambiguous canary: its
    // registration names 'update' in an explicit methods array, so the verb is
    // certainly routed.
    const tampered = captureRegisteredHooks(branchRbacEnabled);
    const boards = tampered.get('boards');
    if (!boards) throw new Error('boards registers no hooks');
    delete boards.before.update;

    expect(findUngated(tampered)).toEqual(['boards (gates create/patch/remove)']);
  });
});

describe.each(RBAC_MODES)(
  'update is refused for under-privileged callers ($name)',
  ({ branchRbacEnabled }) => {
    const captured = captureRegisteredHooks(branchRbacEnabled);

    const runUpdateHooks = async (
      path: string,
      role: string,
      data: Record<string, unknown> = {}
    ) => {
      const chain = captured.get(path)?.before.update;
      if (!chain?.length) throw new Error(`${path} registers no before-update hooks`);
      const context = {
        path,
        method: 'update',
        id: '00000000-0000-7000-8000-000000000001',
        data,
        params: {
          provider: 'rest',
          query: {},
          user: { user_id: '00000000-0000-7000-8000-0000000000ff', role },
        },
      } as unknown as HookContext;
      for (const hook of chain) await hook(context);
      return context;
    };

    it.each([
      ['boards', 'update boards'],
      ['cards', 'update cards'],
      ['card-types', 'update card types'],
      ['board-comments', 'update board comments'],
    ])('refuses a viewer rewriting %s', async (path) => {
      await expect(runUpdateHooks(path, 'viewer')).rejects.toMatchObject({ name: 'Forbidden' });
    });

    it.each(['viewer', 'member', 'admin'])(
      'refuses a %s replacing a message whatever their role',
      async (role) => {
        // Messages are the one write surface here that is not role-gated:
        // whole-row replacement is outside the public Message contract, so it is
        // refused for every external caller and left off the transport method
        // list entirely (see register-services.messages-boundary.test.ts).
        await expect(runUpdateHooks('messages', role)).rejects.toMatchObject({ name: 'Forbidden' });
      }
    );

    it.each(['created_by', 'unix_username'])(
      'refuses a PUT that reassigns session.%s',
      async (field) => {
        // The reattribution primitive the whole fix exists to protect. These two
        // fields select the OS identity a session executes as, so a PUT carrying
        // them must be refused in either RBAC mode — branch_rbac and
        // unix_user_mode are configured independently.
        await expect(
          runUpdateHooks('sessions', 'viewer', {
            [field]: '00000000-0000-7000-8000-00000000beef',
          })
        ).rejects.toMatchObject({ name: 'Forbidden' });
      }
    );

    it('holds sessions.update to the same chain as sessions.patch', () => {
      // SessionsService.update calls this.patch directly rather than going back
      // through the service proxy, so patch's before-hooks never re-run for it.
      // Anything short of the same chain is a route to patch's writes without
      // patch's branch-permission checks.
      const sessions = captured.get('sessions');

      // The recorder copies each chain into its own array, so this compares hook
      // function references pairwise rather than an array against itself.
      expect(sessions?.before.update).not.toBe(sessions?.before.patch);
      expect(sessions?.before.update).toEqual(sessions?.before.patch);
      expect(sessions?.before.update?.length).toBeGreaterThan(0);
    });
  }
);

describe('enabling branch RBAC only adds session guards', () => {
  it('never shortens the sessions write chain', () => {
    const open = captureRegisteredHooks(false).get('sessions');
    const rbac = captureRegisteredHooks(true).get('sessions');

    expect(rbac?.before.update?.length).toBeGreaterThan(open?.before.update?.length ?? 0);
  });
});

describe('pinned methods list', () => {
  const pinned = Object.entries(UPDATE_NOT_ROUTED).filter(
    (entry): entry is [string, readonly string[]] => Array.isArray(entry[1])
  );

  it('covers every exemption that claims a pinned list', () => {
    // Guards the filter above: if the constants stopped being arrays (inlined
    // back into register-services.ts, say) this suite would silently assert
    // nothing while still reading as green.
    expect(pinned.map(([path]) => path)).toEqual([
      'artifacts',
      'gateway-channels',
      'groups',
      'kb/graph',
      'schedules',
      'tasks',
      'users',
    ]);
  });

  it.each(pinned)('%s exposes no update verb', (path, methods) => {
    expect(
      methods,
      `${path} now exposes update, so PUT /${path}/:id is routed. Gate the verb in ` +
        'register-hooks.ts and drop its UPDATE_NOT_ROUTED entry.'
    ).not.toContain('update');
  });
});

describe('Feathers method-list enforcement', () => {
  it('refuses PUT for a service whose exposed methods omit update', async () => {
    // UPDATE_NOT_ROUTED leans on this behaviour for every "methods list omits
    // update" entry: a DrizzleService still has a callable update(), and only
    // the registration's method list keeps it off the wire.
    const service = {
      async get(id: string) {
        return { id };
      },
      async update(id: string, data: Record<string, unknown>) {
        return { id, ...data };
      },
    };

    const app = feathersExpress(feathers());
    app.configure(rest());
    app.use('/narrowed', service, { methods: ['get'] });
    app.use('/wide', service);
    const server = await app.listen(0);
    const { port } = server.address() as { port: number };

    const put = (path: string) =>
      fetch(`http://127.0.0.1:${port}/${path}/1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

    try {
      expect((await put('narrowed')).status).toBe(405);
      expect((await put('wide')).status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
