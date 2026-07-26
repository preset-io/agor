import { homedir } from 'node:os';
import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  OpenCodeOAuthAttempt,
  OpenCodeOAuthAttemptPatch,
  OpenCodeOAuthConnectRequest,
  OpenCodeProviderDiscovery,
  OpenCodeProviderSettings,
  UserID,
} from '@agor/core/types';
import {
  getHomedirFromUsername,
  resolveUnixUserForImpersonation,
  type UnixUserMode,
  validateResolvedUnixUser,
} from '@agor/core/unix';
import {
  assertOpenCodeNativeAuthSupported,
  resolveOpenCodeCredentialNamespace,
} from '../utils/opencode-credential-namespace.js';
import {
  type OpenCodeOAuthExecutorHandle,
  runExecutorCommand,
  startOpenCodeOAuthExecutor,
} from '../utils/spawn-executor.js';

const mutationSlots = new Map<string, Promise<void>>();
// An unverified OAuth process keeps the same namespace coordinator closed.
// The stored verifier delegates recovery to the existing tracked-process owner.
const blockedNamespaces = new Map<string, () => Promise<boolean>>();
const AUTH_EXECUTOR_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_ENV',
  'LOG_LEVEL',
] as const;

async function inMutationSlot<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = mutationSlots.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const verifyAbsence = blockedNamespaces.get(key);
      if (verifyAbsence) {
        let verified = false;
        try {
          verified = await verifyAbsence();
        } catch {
          // Existing containment owns details; the public service stays secret-safe.
        }
        if (!verified) {
          throw new BadRequest(
            'OpenCode provider cleanup could not be verified. Later mutations remain blocked.'
          );
        }
        if (blockedNamespaces.get(key) === verifyAbsence) blockedNamespaces.delete(key);
      }
      return work();
    });
  const settled = current.then(
    () => undefined,
    () => undefined
  );
  mutationSlots.set(key, settled);
  try {
    return await current;
  } finally {
    if (mutationSlots.get(key) === settled) mutationSlots.delete(key);
  }
}

type CredentialContext = {
  namespaceKey: string;
  dataHome: string;
  asUser: string | null;
  mode: UnixUserMode;
};

type StoredOAuthAttempt = OpenCodeOAuthAttempt & {
  namespaceKey: string;
  handle?: OpenCodeOAuthExecutorHandle;
  cancelRequested: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
};

const oauthAttempts = new Map<string, StoredOAuthAttempt>();
const OAUTH_TIMEOUT_MS = 10 * 60_000;
const OAUTH_TERMINAL_RETENTION_MS = 10 * 60_000;

function scheduleAttemptPrune(attempt: StoredOAuthAttempt): void {
  const timer = setTimeout(() => {
    if (oauthAttempts.get(attempt.attemptId) === attempt) {
      oauthAttempts.delete(attempt.attemptId);
    }
  }, OAUTH_TERMINAL_RETENTION_MS);
  timer.unref();
}

export class OpenCodeAuthService {
  constructor(private readonly db: TenantScopeAwareDatabase) {}

  private async credentialContext(params?: AuthenticatedParams): Promise<CredentialContext> {
    const callerId = params?.user?.user_id as UserID | undefined;
    if (!callerId) throw new NotAuthenticated('Sign in before managing OpenCode providers.');

    const config = loadConfigSync();
    assertOpenCodeNativeAuthSupported(config);
    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new NotAuthenticated('Missing tenant context for OpenCode providers.');

    const user = await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) => {
      if (!(await isTenantAgenticToolEnabled('opencode', tenantDb))) {
        throw new BadRequest('OpenCode is disabled for this workspace.');
      }
      return new UsersRepository(tenantDb).findById(callerId);
    });
    if (!user) throw new NotAuthenticated('Authenticated OpenCode user no longer exists.');

    const mode = (config.execution?.unix_user_mode ?? 'simple') as UnixUserMode;
    const { unixUser } = resolveUnixUserForImpersonation({
      mode,
      userUnixUsername: user.unix_username,
      executorUnixUser: config.execution?.executor_unix_user,
    });
    validateResolvedUnixUser(mode, unixUser);
    const homeDir = unixUser ? getHomedirFromUsername(unixUser) : homedir();
    if (!homeDir) {
      throw new BadRequest('Could not resolve the Unix home used by OpenCode execution.');
    }
    return {
      ...resolveOpenCodeCredentialNamespace({
        tenantId,
        subjectUserId: callerId,
        homeDir,
      }),
      asUser: unixUser,
      mode,
    };
  }

  private async execute(
    context: CredentialContext,
    params:
      | { operation: 'discover' }
      | {
          operation: 'connect-api-key';
          providerId: string;
          apiKey: string;
          metadata?: Record<string, string>;
        }
      | { operation: 'disconnect'; providerId: string }
  ): Promise<OpenCodeProviderDiscovery> {
    const result = await runExecutorCommand(
      {
        command: 'opencode.auth',
        dataHome: context.dataHome,
        params,
      },
      {
        asUser: context.asUser,
        env: Object.fromEntries(
          AUTH_EXECUTOR_ENV_KEYS.flatMap((key) =>
            process.env[key] === undefined ? [] : [[key, process.env[key]]]
          )
        ) as Record<string, string>,
        logPrefix: '[OpenCode Auth]',
        templateVariables: { unix_user: context.asUser ?? undefined },
      }
    );
    if (!result.success || !result.data) {
      throw new BadRequest('OpenCode provider operation failed. Try again.');
    }
    return result.data as OpenCodeProviderDiscovery;
  }

  private settings(
    context: CredentialContext,
    discovery: OpenCodeProviderDiscovery
  ): OpenCodeProviderSettings {
    return {
      runtime: discovery.runtime,
      runtimeVersion: discovery.runtimeVersion,
      providers: discovery.providers,
      isolation: {
        mode: context.mode,
        boundary: context.mode === 'strict' ? 'os' : 'logical',
      },
    };
  }

  async find(params?: AuthenticatedParams): Promise<OpenCodeProviderSettings> {
    const context = await this.credentialContext(params);
    const result = await this.execute(context, { operation: 'discover' });
    return this.settings(context, result);
  }

  async create(
    data:
      | { providerId?: string; apiKey?: string; metadata?: Record<string, string> }
      | OpenCodeOAuthConnectRequest,
    params?: AuthenticatedParams
  ): Promise<OpenCodeProviderSettings | OpenCodeOAuthAttempt> {
    if ('operation' in data) {
      return this.startOAuth(data, params);
    }
    const unsupported = Object.keys(data ?? {}).find(
      (field) => field !== 'providerId' && field !== 'apiKey' && field !== 'metadata'
    );
    if (unsupported) throw new BadRequest(`Unsupported field: ${unsupported}`);
    const providerId = data?.providerId?.trim();
    const apiKey = data?.apiKey?.trim();
    if (!providerId || !apiKey) throw new BadRequest('Provider and API key are required.');
    const metadata = data.metadata;
    if (
      metadata !== undefined &&
      (!metadata ||
        Array.isArray(metadata) ||
        typeof metadata !== 'object' ||
        Object.values(metadata).some((value) => typeof value !== 'string'))
    ) {
      throw new BadRequest('Provider prompt values must be strings.');
    }

    const context = await this.credentialContext(params);
    const result = await inMutationSlot(context.namespaceKey, () =>
      this.execute(context, { operation: 'connect-api-key', providerId, apiKey, metadata })
    );
    return this.settings(context, result);
  }

  private publicAttempt(attempt: StoredOAuthAttempt): OpenCodeOAuthAttempt {
    const { attemptId, providerId, phase, authorization, expiresAt, settings } = attempt;
    return {
      attemptId,
      providerId,
      phase,
      expiresAt,
      ...(authorization ? { authorization } : {}),
      ...(settings ? { settings } : {}),
    };
  }

  private settleAttempt(
    attempt: StoredOAuthAttempt,
    result: Awaited<OpenCodeOAuthExecutorHandle['result']>,
    context: CredentialContext
  ): void {
    if (result.success && result.data) {
      const discovery = result.data as OpenCodeProviderDiscovery;
      const configured = discovery.providers.some(
        (provider) => provider.id === attempt.providerId && provider.configured
      );
      if (configured) {
        attempt.settings = this.settings(context, discovery);
        attempt.phase = 'configured';
      } else {
        attempt.phase = 'failed';
      }
    } else if (result.error?.code === 'OPENCODE_OAUTH_TIMEOUT') {
      attempt.phase = 'expired';
    } else if (result.error?.code === 'OPENCODE_OAUTH_CANCELLED') {
      attempt.phase = 'cancelled';
    } else {
      attempt.phase = 'failed';
    }
    attempt.resolveReady();
  }

  private async ownedAttempt(
    id: string,
    params?: AuthenticatedParams
  ): Promise<StoredOAuthAttempt> {
    const context = await this.credentialContext(params);
    const attempt = oauthAttempts.get(id);
    if (!attempt || attempt.namespaceKey !== context.namespaceKey) {
      throw new NotFound('OpenCode OAuth attempt was not found.');
    }
    return attempt;
  }

  private async startOAuth(
    data: OpenCodeOAuthConnectRequest,
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
    const unsupported = Object.keys(data).find(
      (field) =>
        field !== 'operation' && field !== 'providerId' && field !== 'method' && field !== 'inputs'
    );
    if (unsupported) throw new BadRequest(`Unsupported field: ${unsupported}`);
    const providerId = data.providerId?.trim();
    if (!providerId || !Number.isInteger(data.method) || data.method < 0) {
      throw new BadRequest('Provider and OAuth method are required.');
    }
    if (
      data.inputs !== undefined &&
      (!data.inputs ||
        Array.isArray(data.inputs) ||
        typeof data.inputs !== 'object' ||
        Object.values(data.inputs).some((value) => typeof value !== 'string'))
    ) {
      throw new BadRequest('Provider prompt values must be strings.');
    }

    const context = await this.credentialContext(params);
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const attempt: StoredOAuthAttempt = {
      attemptId: crypto.randomUUID(),
      providerId,
      phase: 'authorizing',
      expiresAt: new Date(Date.now() + OAUTH_TIMEOUT_MS).toISOString(),
      namespaceKey: context.namespaceKey,
      cancelRequested: false,
      ready,
      resolveReady,
    };
    oauthAttempts.set(attempt.attemptId, attempt);

    void inMutationSlot(context.namespaceKey, async () => {
      if (attempt.cancelRequested) {
        attempt.phase = 'cancelled';
        attempt.resolveReady();
        scheduleAttemptPrune(attempt);
        return;
      }
      const handle = startOpenCodeOAuthExecutor(
        {
          command: 'opencode.auth',
          dataHome: context.dataHome,
          params: {
            operation: 'connect-oauth',
            providerId,
            method: data.method,
            ...(data.inputs && Object.keys(data.inputs).length > 0 ? { inputs: data.inputs } : {}),
          },
        },
        {
          asUser: context.asUser,
          env: Object.fromEntries(
            AUTH_EXECUTOR_ENV_KEYS.flatMap((key) =>
              process.env[key] === undefined ? [] : [[key, process.env[key]]]
            )
          ) as Record<string, string>,
          logPrefix: '[OpenCode Auth]',
          templateVariables: { unix_user: context.asUser ?? undefined },
          timeoutMs: OAUTH_TIMEOUT_MS,
        },
        (event) => {
          if (attempt.cancelRequested) return;
          if (event.type === 'authorized') {
            attempt.authorization = event.authorization;
            attempt.phase = 'awaiting_callback';
            attempt.resolveReady();
          } else {
            attempt.phase = 'completing';
          }
        }
      );
      attempt.handle = handle;
      const result = await handle.result;
      if (result.error?.code === 'OPENCODE_OAUTH_CLEANUP_UNVERIFIED') {
        blockedNamespaces.set(context.namespaceKey, () => handle.verifyAbsence());
      }
      this.settleAttempt(attempt, result, context);
      scheduleAttemptPrune(attempt);
    }).catch(() => {
      if (!attempt.cancelRequested) attempt.phase = 'failed';
      attempt.resolveReady();
      scheduleAttemptPrune(attempt);
    });

    await attempt.ready;
    return this.publicAttempt(attempt);
  }

  async get(id: string, params?: AuthenticatedParams): Promise<OpenCodeOAuthAttempt> {
    return this.publicAttempt(await this.ownedAttempt(id, params));
  }

  async patch(
    id: string,
    data: OpenCodeOAuthAttemptPatch,
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
    const attempt = await this.ownedAttempt(id, params);
    if (
      attempt.phase === 'configured' ||
      attempt.phase === 'cancelled' ||
      attempt.phase === 'expired' ||
      attempt.phase === 'failed'
    ) {
      return this.publicAttempt(attempt);
    }
    if ('code' in data) {
      if (Object.keys(data).some((field) => field !== 'code')) {
        throw new BadRequest('Unsupported OAuth callback field.');
      }
      const code = data.code?.trim();
      if (
        !code ||
        attempt.phase !== 'awaiting_callback' ||
        attempt.authorization?.method !== 'code' ||
        !attempt.handle
      ) {
        throw new BadRequest('This OAuth attempt is not awaiting a code.');
      }
      if (!(await attempt.handle.submitCode(code))) {
        throw new BadRequest('This OAuth attempt no longer accepts a code.');
      }
      if (attempt.cancelRequested) {
        this.settleAttempt(
          attempt,
          await attempt.handle.result,
          await this.credentialContext(params)
        );
        return this.publicAttempt(attempt);
      }
      attempt.phase = 'completing';
      return this.publicAttempt(attempt);
    }
    if (data.cancel !== true || Object.keys(data).some((field) => field !== 'cancel')) {
      throw new BadRequest('Only OAuth cancellation or code submission is supported.');
    }
    attempt.cancelRequested = true;
    if (!attempt.handle) {
      attempt.phase = 'cancelled';
      attempt.resolveReady();
      return this.publicAttempt(attempt);
    }
    const result = await attempt.handle.cancel();
    this.settleAttempt(attempt, result, await this.credentialContext(params));
    return this.publicAttempt(attempt);
  }

  async remove(id: string, params?: AuthenticatedParams): Promise<OpenCodeProviderSettings> {
    const providerId = id?.trim();
    if (!providerId) throw new BadRequest('Provider is required.');
    const context = await this.credentialContext(params);
    const result = await inMutationSlot(context.namespaceKey, () =>
      this.execute(context, { operation: 'disconnect', providerId })
    );
    return this.settings(context, result);
  }
}

export function createOpenCodeAuthService(db: TenantScopeAwareDatabase) {
  return new OpenCodeAuthService(db);
}
