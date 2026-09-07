import { OPENCODE_RUNTIME_UNAVAILABLE_ERROR_CODE } from '@agor/agentic-tool-opencode';
import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  DeepReadonly,
  OpenCodeOAuthAttempt,
  OpenCodeOAuthAttemptPatch,
  OpenCodeOAuthConnectRequest,
  OpenCodeProviderDiscovery,
  OpenCodeProviderSettings,
} from '@agor/core/types';
import { resolveOpenCodeConfigurationDirectory } from './configuration-scope.js';
import {
  type AuthenticatedOpenCodeSubjectContext,
  resolveAuthenticatedOpenCodeSubjectContext,
} from './credential-namespace.js';
import { startOpenCodeExecutorInvocation } from './executor-command.js';
import {
  blockOpenCodeNativeStateNamespace,
  inOpenCodeNativeStateMutationSlot,
  type OpenCodeNativeStateMutationFence,
} from './native-state-coordinator.js';
import { type OpenCodeOAuthExecutorHandle, startOpenCodeOAuthExecutor } from './oauth-executor.js';

function assertOptionalStringRecord(
  value: unknown
): asserts value is Record<string, string> | undefined {
  if (
    value !== undefined &&
    (!value ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      Object.values(value).some((entry) => typeof entry !== 'string'))
  ) {
    throw new BadRequest('Provider prompt values must be strings.');
  }
}

type StoredOAuthAttempt = OpenCodeOAuthAttempt & {
  namespaceKey: string;
  handle?: OpenCodeOAuthExecutorHandle;
  attachment?: Promise<void>;
  cancelRequested: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
};

const oauthAttempts = new Map<string, StoredOAuthAttempt>();
const OAUTH_TIMEOUT_MS = 10 * 60_000;
const OAUTH_TERMINAL_RETENTION_MS = 10 * 60_000;

type ValidatedOAuthRequest = {
  providerId: string;
  method: number;
  inputs?: Record<string, string>;
};

function validateOAuthRequest(data: OpenCodeOAuthConnectRequest): ValidatedOAuthRequest {
  const supportedFields = new Set(['operation', 'providerId', 'method', 'inputs']);
  const unsupported = Object.keys(data).find((field) => !supportedFields.has(field));
  if (unsupported) throw new BadRequest(`Unsupported field: ${unsupported}`);

  const providerId = data.providerId?.trim();
  if (!providerId || !Number.isInteger(data.method) || data.method < 0) {
    throw new BadRequest('Provider and OAuth method are required.');
  }
  assertOptionalStringRecord(data.inputs);
  return { providerId, method: data.method, inputs: data.inputs };
}

function createOAuthAttempt(providerId: string, namespaceKey: string): StoredOAuthAttempt {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return {
    attemptId: crypto.randomUUID(),
    providerId,
    phase: 'authorizing',
    expiresAt: new Date(Date.now() + OAUTH_TIMEOUT_MS).toISOString(),
    namespaceKey,
    cancelRequested: false,
    ready,
    resolveReady,
  };
}

function isTerminalAttempt(attempt: StoredOAuthAttempt): boolean {
  return ['configured', 'cancelled', 'expired', 'failed'].includes(attempt.phase);
}

function scheduleAttemptPrune(attempt: StoredOAuthAttempt): void {
  const timer = setTimeout(() => {
    if (oauthAttempts.get(attempt.attemptId) === attempt) {
      oauthAttempts.delete(attempt.attemptId);
    }
  }, OAUTH_TERMINAL_RETENTION_MS);
  timer.unref();
}

export class OpenCodeAuthService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>
  ) {}

  private credentialContext(
    params?: AuthenticatedParams
  ): Promise<AuthenticatedOpenCodeSubjectContext> {
    return resolveAuthenticatedOpenCodeSubjectContext(this.db, this.config, params);
  }

  private async execute(
    context: AuthenticatedOpenCodeSubjectContext,
    params:
      | { operation: 'discover'; directory?: string }
      | {
          operation: 'connect-api-key';
          providerId: string;
          apiKey: string;
          metadata?: Record<string, string>;
        }
      | { operation: 'disconnect'; providerId: string },
    mutationFence?: OpenCodeNativeStateMutationFence
  ): Promise<OpenCodeProviderDiscovery> {
    const handle = startOpenCodeExecutorInvocation(context.dataHome, params, {
      env: context.executorEnv,
      logPrefix: '[OpenCode Auth]',
    });
    if (mutationFence) await mutationFence.attach(handle);
    const result = await handle.result;
    if (!mutationFence && result.error?.code === 'EXECUTOR_CLEANUP_UNVERIFIED') {
      await blockOpenCodeNativeStateNamespace(context.namespaceKey, handle);
    }
    if (!result.success || !result.data) {
      if (result.error?.code === OPENCODE_RUNTIME_UNAVAILABLE_ERROR_CODE && result.error.message) {
        throw new BadRequest(result.error.message);
      }
      throw new BadRequest('OpenCode provider operation failed. Try again.');
    }
    return result.data as OpenCodeProviderDiscovery;
  }

  private settings(
    context: AuthenticatedOpenCodeSubjectContext,
    discovery: OpenCodeProviderDiscovery
  ): OpenCodeProviderSettings {
    return {
      ...discovery,
      isolation: {
        mode: context.mode,
        boundary: 'logical',
      },
    };
  }

  async find(
    params?: AuthenticatedParams & { query?: { branch_id?: unknown } }
  ): Promise<OpenCodeProviderSettings> {
    const context = await resolveAuthenticatedOpenCodeSubjectContext(this.db, this.config, params);
    const directory = await resolveOpenCodeConfigurationDirectory({
      db: this.db,
      context,
      config: this.config,
      params,
    });
    const result = await this.execute(context, {
      operation: 'discover',
      ...(directory ? { directory } : {}),
    });
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
    assertOptionalStringRecord(metadata);

    const context = await this.credentialContext(params);
    const result = await inOpenCodeNativeStateMutationSlot(context.namespaceKey, (fence) =>
      this.execute(context, { operation: 'connect-api-key', providerId, apiKey, metadata }, fence)
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
    context: AuthenticatedOpenCodeSubjectContext
  ): void {
    if (isTerminalAttempt(attempt)) return;
    if (result.success && result.data) {
      const discovery = result.data as OpenCodeProviderDiscovery;
      const savedCredentialPresent = discovery.providers.some(
        (provider) =>
          provider.id === attempt.providerId && provider.credentialPresence === 'present'
      );
      if (savedCredentialPresent) {
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

  private async runOAuthAttempt(
    attempt: StoredOAuthAttempt,
    context: AuthenticatedOpenCodeSubjectContext,
    request: ValidatedOAuthRequest
  ): Promise<void> {
    await inOpenCodeNativeStateMutationSlot(context.namespaceKey, async (fence) => {
      if (attempt.cancelRequested) {
        await fence.releaseWithoutWriter();
        attempt.phase = 'cancelled';
        attempt.resolveReady();
        scheduleAttemptPrune(attempt);
        return;
      }
      const handle = startOpenCodeOAuthExecutor(
        context.dataHome,
        {
          operation: 'connect-oauth',
          providerId: request.providerId,
          method: request.method,
          ...(request.inputs && Object.keys(request.inputs).length > 0
            ? { inputs: request.inputs }
            : {}),
        },
        {
          env: context.executorEnv,
          logPrefix: '[OpenCode Auth]',
          timeoutMs: OAUTH_TIMEOUT_MS,
        },
        (event) => {
          if (attempt.cancelRequested) return;
          if (event.type === 'authorized') {
            attempt.authorization = event.authorization;
            attempt.phase = 'awaiting_callback';
            attempt.resolveReady();
            return;
          }
          attempt.phase = 'completing';
        }
      );
      attempt.handle = handle;
      const attachment = fence.attach(handle);
      attempt.attachment = attachment;
      await attachment;
      if (attempt.cancelRequested) await handle.cancel();

      const result = await handle.result;
      this.settleAttempt(attempt, result, context);
      scheduleAttemptPrune(attempt);
    });
  }

  private failOAuthAttempt(attempt: StoredOAuthAttempt): void {
    if (!attempt.cancelRequested) attempt.phase = 'failed';
    attempt.resolveReady();
    scheduleAttemptPrune(attempt);
  }

  private async startOAuth(
    data: OpenCodeOAuthConnectRequest,
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
    const request = validateOAuthRequest(data);
    const context = await this.credentialContext(params);
    const attempt = createOAuthAttempt(request.providerId, context.namespaceKey);
    oauthAttempts.set(attempt.attemptId, attempt);

    void this.runOAuthAttempt(attempt, context, request).catch(() =>
      this.failOAuthAttempt(attempt)
    );

    await attempt.ready;
    return this.publicAttempt(attempt);
  }

  async get(id: string, params?: AuthenticatedParams): Promise<OpenCodeOAuthAttempt> {
    return this.publicAttempt(await this.ownedAttempt(id, params));
  }

  private async submitOAuthCode(
    attempt: StoredOAuthAttempt,
    data: { code: string },
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
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

  private async cancelOAuthAttempt(
    attempt: StoredOAuthAttempt,
    data: { cancel: true },
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
    if (data.cancel !== true || Object.keys(data).some((field) => field !== 'cancel')) {
      throw new BadRequest('Only OAuth cancellation or code submission is supported.');
    }
    attempt.cancelRequested = true;
    if (!attempt.handle) {
      attempt.phase = 'cancelled';
      attempt.resolveReady();
      return this.publicAttempt(attempt);
    }
    await attempt.attachment?.catch(() => undefined);
    const result = await attempt.handle.cancel();
    this.settleAttempt(attempt, result, await this.credentialContext(params));
    return this.publicAttempt(attempt);
  }

  async patch(
    id: string,
    data: OpenCodeOAuthAttemptPatch,
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
    const attempt = await this.ownedAttempt(id, params);
    if (isTerminalAttempt(attempt)) return this.publicAttempt(attempt);
    if ('code' in data) {
      return this.submitOAuthCode(attempt, data, params);
    }
    return this.cancelOAuthAttempt(attempt, data, params);
  }

  async remove(id: string, params?: AuthenticatedParams): Promise<OpenCodeProviderSettings> {
    const providerId = id?.trim();
    if (!providerId) throw new BadRequest('Provider is required.');
    const context = await this.credentialContext(params);
    const result = await inOpenCodeNativeStateMutationSlot(context.namespaceKey, (fence) =>
      this.execute(context, { operation: 'disconnect', providerId }, fence)
    );
    return this.settings(context, result);
  }
}

export function createOpenCodeAuthService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>
) {
  return new OpenCodeAuthService(db, config);
}
