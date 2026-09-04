import { describe, expect, it, vi } from 'vitest';
import { deleteClaudeAuthViaExecutor } from '../utils/executor-claude-auth.js';
import { deleteCodexAuthCredential } from '../utils/executor-codex-auth.js';
import {
  CLAUDE_AUTH_TRUSTED_USER_MUTATION,
  canManageClaudeCredentialRoute,
  createClaudeUserCredentialPatchCoordinator,
  needsUserCredentialRouteCoordinator,
} from './claude-credential-mutation.js';
import { resolveCodexCredentialRoute } from './codex-auth-shared.js';

vi.mock('../utils/executor-claude-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/executor-claude-auth.js')>();
  return { ...actual, deleteClaudeAuthViaExecutor: vi.fn() };
});
vi.mock('../utils/executor-codex-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/executor-codex-auth.js')>();
  return { ...actual, deleteCodexAuthCredential: vi.fn() };
});
vi.mock('./codex-auth-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex-auth-shared.js')>();
  return { ...actual, resolveCodexCredentialRoute: vi.fn() };
});

const deleteClaudeAuthViaExecutorMock = vi.mocked(deleteClaudeAuthViaExecutor);
const deleteCodexAuthCredentialMock = vi.mocked(deleteCodexAuthCredential);
const resolveCodexCredentialRouteMock = vi.mocked(resolveCodexCredentialRoute);

describe('Claude user credential mutation boundary', () => {
  it('retains safe local cleanup authority when runtime containment admission is disabled', () => {
    const config = {
      execution: {
        unix_user_mode: 'sandbox',
        executor_storage: {
          user_home: 'persistent-per-user',
          user_home_locking: 'cross-replica-flock',
        },
        sandbox: {
          enabled: true,
          home_mode: 'per_user',
          extra_allow_write: ['/home/agor/.agor'],
        },
      },
    } as never;
    expect(
      canManageClaudeCredentialRoute(
        { mode: 'ha', topology: { execution: 'shared-local' } } as never,
        config
      )
    ).toBe(true);
    expect(
      canManageClaudeCredentialRoute(
        { mode: 'ha', topology: { execution: 'external' } } as never,
        config
      )
    ).toBe(false);
    expect(
      canManageClaudeCredentialRoute(
        { mode: 'ha', topology: { execution: 'shared-local' } } as never,
        {
          execution: {
            ...config.execution,
            executor_storage: {
              ...config.execution.executor_storage,
              user_home_locking: 'local-only',
            },
          },
        } as never
      )
    ).toBe(false);
  });

  it('coordinates a Codex-only HA credential-file profile without requiring Claude auth', () => {
    expect(
      needsUserCredentialRouteCoordinator({
        mode: 'ha',
        capabilities: {
          codexCredentialFiles: true,
          claudeOAuth: false,
          claudeAuth: false,
        },
      } as never)
    ).toBe(true);
  });

  it('cleans Codex but never grants Claude path deletion in a Codex-only HA profile', async () => {
    resolveCodexCredentialRouteMock.mockResolvedValueOnce({
      ok: true,
      delegatedHomeKey: 'delegated-user',
      userId: 'user-a' as never,
    });
    const codexCompletion = vi.fn(async (_tenantId, _userId, work) => work(19));
    const codexOnly = createClaudeUserCredentialPatchCoordinator(
      {
        get: () => ({ execution: { unix_user_mode: 'delegated' } }),
        service: () => undefined,
      } as never,
      {} as never,
      {
        lockExternalUserMutation: async () => undefined,
        completeExternalUserMutation: async (_tenantId, _userId, work) => work(17),
      },
      { completeExternalUserRouteMutation: codexCompletion } as never,
      { manageClaudeRoute: false }
    );

    await codexOnly.cleanupRouteBeforeRemove('tenant-a', 'user-a' as never);

    expect(codexCompletion).toHaveBeenCalled();
    expect(deleteCodexAuthCredentialMock).toHaveBeenCalledWith(
      { delegatedHomeKey: 'delegated-user', userId: 'user-a' },
      19
    );
    expect(deleteClaudeAuthViaExecutorMock).not.toHaveBeenCalled();
  });

  const coordinator = createClaudeUserCredentialPatchCoordinator(
    {
      get: () => ({
        execution: {
          unix_user_mode: 'delegated',
          sandbox: { enabled: true, home_mode: 'per_user' },
        },
      }),
      service: () => undefined,
    } as never,
    {} as never,
    {} as never
  );

  it.each([
    ['auth method', { agentic_auth_methods: { 'claude-code': 'subscription' } }],
    [
      'explicit credential source',
      { agentic_credential_sources: { 'claude-code': 'subscription_token' } },
    ],
    ['Anthropic API key', { agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: 'secret' } } }],
    [
      'Anthropic auth token',
      { agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: 'secret' } } },
    ],
    [
      'pasted subscription token',
      { agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'secret' } } },
    ],
  ])('coordinates every external Claude %s mutation', (_label, data) => {
    expect(coordinator.applies(data, {} as never)).toBe(true);
  });

  it('does not serialize unrelated user or Claude preference changes', () => {
    expect(coordinator.applies({ agentic_auth_methods: { codex: 'subscription' } }, {})).toBe(
      false
    );
    expect(
      coordinator.applies(
        { agentic_tools: { 'claude-code': { DEFAULT_MODEL: 'claude-opus-4-1' } } },
        {}
      )
    ).toBe(false);
  });

  it.each([
    ['delegated home key', { unix_username: 'alice-next' }],
    ['filesystem home', { filesystem_home: '/srv/agor/homes/alice-next' }],
  ])('coordinates every %s mutation', (_label, data) => {
    expect(coordinator.changesRoute(data)).toBe(true);
    expect(coordinator.applies(data, {} as never)).toBe(true);
  });

  it('coordinates every removal while leaving shared-home route deletion to the coordinator', () => {
    expect(coordinator.coordinatesRemoval()).toBe(true);
    const sharedHome = createClaudeUserCredentialPatchCoordinator(
      {
        get: () => ({ execution: { unix_user_mode: 'simple' } }),
        service: () => undefined,
      } as never,
      {} as never,
      {} as never
    );
    expect(sharedHome.coordinatesRemoval()).toBe(true);
    expect(sharedHome.applies({ unix_username: 'not-a-simple-mode-route' }, {})).toBe(false);
  });

  it('invalidates shared-home removal without resolving or deleting the process credential', async () => {
    const completions: Array<{ tenantId: string; userId: string; reason: string | undefined }> = [];
    const sharedHome = createClaudeUserCredentialPatchCoordinator(
      {
        get: () => ({ execution: { unix_user_mode: 'simple' } }),
        service: () => undefined,
      } as never,
      // Deliberately unusable: shared-home cleanup must not query a per-user route.
      {} as never,
      {
        lockExternalUserMutation: async () => undefined,
        completeExternalUserMutation: async (tenantId, userId, work, reason) => {
          completions.push({ tenantId, userId, reason });
          await work(7);
        },
      }
    );

    await sharedHome.cleanupRouteBeforeRemove('tenant-a', 'user-a');

    expect(completions).toEqual([
      { tenantId: 'tenant-a', userId: 'user-a', reason: 'user_removed' },
    ]);
  });

  it('completes a standalone source patch even when native credential routing is unsupported', async () => {
    let completed = false;
    const unsupportedStandalone = createClaudeUserCredentialPatchCoordinator(
      {
        get: () => ({
          deployment: { mode: 'standalone' },
          multi_tenancy: { mode: 'required_from_auth' },
          execution: { unix_user_mode: 'simple' },
        }),
        service: () => undefined,
      } as never,
      // Route resolution would fail through this handle; standalone source
      // completion must only invalidate under the already-held process queue.
      {} as never,
      {
        lockExternalUserMutation: async () => undefined,
        completeExternalUserMutation: async (_tenantId, _userId, work) => {
          completed = true;
          await work(11);
        },
      }
    );

    await unsupportedStandalone.complete('tenant-a', 'user-a');

    expect(completed).toBe(true);
  });

  it('does not recursively acquire authority for the trusted OAuth/logout users patch', () => {
    expect(
      coordinator.applies(
        {
          agentic_auth_methods: { 'claude-code': 'subscription' },
          agentic_credential_sources: { 'claude-code': 'managed_file' },
        },
        {
          [CLAUDE_AUTH_TRUSTED_USER_MUTATION]: true,
        } as never
      )
    ).toBe(false);
  });

  it('never lets the trusted metadata marker bypass a route mutation', () => {
    expect(
      coordinator.applies({ filesystem_home: '/srv/agor/homes/changed' }, {
        [CLAUDE_AUTH_TRUSTED_USER_MUTATION]: true,
      } as never)
    ).toBe(true);
  });
});
