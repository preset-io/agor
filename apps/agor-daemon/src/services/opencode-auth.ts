import { homedir } from 'node:os';
import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
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
import { runExecutorCommand } from '../utils/spawn-executor.js';

const mutationSlots = new Map<string, Promise<void>>();
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
  const current = previous.catch(() => undefined).then(work);
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
    data: { providerId?: string; apiKey?: string; metadata?: Record<string, string> },
    params?: AuthenticatedParams
  ): Promise<OpenCodeProviderSettings> {
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
