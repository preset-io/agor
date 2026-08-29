import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  OpenCodeModelCatalog,
  OpenCodeModelPair,
  OpenCodeOAuthAuthorization,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderConnection,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';
import type { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { OPENCODE_RUNTIME_UNAVAILABLE_ERROR_CODE } from '../shared/index.js';
import { createOpenCodeKnownModelCatalog } from '../shared/known-models.js';
import type { OpenCodeAuthPayload } from './auth-payload.js';
import { resolvePackagedOpenCodeBinary } from './binary.js';
import {
  ensureOpenCodeDataHome as defaultEnsureOpenCodeDataHome,
  startManagedOpenCodeServer as defaultStartManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary as defaultVerifyOpenCodeAuthFileBoundary,
  OPENCODE_VERSION,
} from './managed-server.js';
import { loadOpenCodeSdkV2 } from './sdk-loader.js';

export type { OpenCodeAuthPayload } from './auth-payload.js';

export interface OpenCodeCommandOptions {
  dryRun?: boolean;
}

export interface OpenCodeAuthRuntimeDependencies {
  ensureOpenCodeDataHome: typeof defaultEnsureOpenCodeDataHome;
  startManagedOpenCodeServer: typeof defaultStartManagedOpenCodeServer;
  verifyOpenCodeAuthFileBoundary: typeof defaultVerifyOpenCodeAuthFileBoundary;
  resolveOpenCodeBinary: typeof resolvePackagedOpenCodeBinary;
}

const DEFAULT_AUTH_RUNTIME: OpenCodeAuthRuntimeDependencies = {
  ensureOpenCodeDataHome: defaultEnsureOpenCodeDataHome,
  startManagedOpenCodeServer: defaultStartManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary: defaultVerifyOpenCodeAuthFileBoundary,
  resolveOpenCodeBinary: resolvePackagedOpenCodeBinary,
};

/**
 * Resolves the pinned OpenCode binary before any credential or server work.
 * Failing here is a host-configuration problem, not an auth outcome, so the
 * resolver's message is returned verbatim under a dedicated error code
 * instead of the deliberately opaque OPENCODE_AUTH_FAILED envelope.
 */
async function runtimeUnavailableFailure(
  runtime: OpenCodeAuthRuntimeDependencies
): Promise<{ success: false; error: { code: string; message: string } } | undefined> {
  try {
    await runtime.resolveOpenCodeBinary();
    return undefined;
  } catch (error) {
    return {
      success: false,
      error: {
        code: OPENCODE_RUNTIME_UNAVAILABLE_ERROR_CODE,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

type V2Client = ReturnType<typeof createOpencodeClient>;
type ProviderAuthMethods = NonNullable<Awaited<ReturnType<V2Client['provider']['auth']>>['data']>;
type ProviderAuthPrompt = NonNullable<ProviderAuthMethods[string][number]['prompts']>[number];

function safeAuthPrompt(prompt: ProviderAuthPrompt) {
  const condition = prompt.when ? { when: prompt.when } : {};
  if (prompt.type === 'select') {
    return {
      type: prompt.type,
      key: prompt.key,
      message: prompt.message,
      options: prompt.options.map(({ label, value, hint }) => ({
        label,
        value,
        ...(hint ? { hint } : {}),
      })),
      ...condition,
    };
  }
  return {
    type: prompt.type,
    key: prompt.key,
    message: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
    ...condition,
  };
}

function safeMethods(
  methods: Awaited<ReturnType<V2Client['provider']['auth']>>['data'] | undefined,
  providerId: string
): OpenCodeProviderAuthMethod[] {
  return (methods?.[providerId] ?? []).map((method, index) => ({
    index,
    type: method.type,
    label: method.label,
    ...(method.prompts
      ? {
          prompts: method.prompts.map(safeAuthPrompt),
        }
      : {}),
  }));
}

function credentialPresence(
  providerIds: Set<string> | null,
  providerId: string
): OpenCodeProviderConnection['credentialPresence'] {
  if (providerIds === null) return 'unknown';
  return providerIds.has(providerId) ? 'present' : 'absent';
}

async function withFreshClient<T>(
  dataHome: string,
  secrets: readonly unknown[],
  work: (client: V2Client) => Promise<T>,
  directory = dataHome,
  runtime = DEFAULT_AUTH_RUNTIME
): Promise<T> {
  await runtime.ensureOpenCodeDataHome(dataHome);
  await runtime.verifyOpenCodeAuthFileBoundary(dataHome, { allowMissing: true });
  const server = await runtime.startManagedOpenCodeServer({
    directory,
    dataHome,
    secrets: [...secrets, directory],
  });
  const { createOpencodeClient } = await loadOpenCodeSdkV2();
  const client = createOpencodeClient({
    baseUrl: server.baseUrl,
    directory,
    headers: { Authorization: server.authorization },
  });
  let result: T | undefined;
  const failures: Array<{ phase: string; error: unknown }> = [];
  try {
    result = await work(client);
  } catch (error) {
    failures.push({ phase: 'operation', error });
  }
  try {
    await client.instance.dispose({ directory });
  } catch (error) {
    failures.push({ phase: 'instance disposal', error });
  } finally {
    try {
      await server.close();
    } catch (error) {
      failures.push({ phase: 'managed child close', error });
    }
  }
  if (failures.length > 0) {
    const cause = failures.reduceRight<Error | undefined>((next, failure) => {
      const message =
        failure.error instanceof Error ? failure.error.message : String(failure.error);
      return new Error(`${failure.phase} failed: ${message}`, next ? { cause: next } : undefined);
    }, undefined);
    throw server.sanitizer.error(
      new Error('OpenCode provider runtime operation failed', { cause })
    );
  }
  return result as T;
}

async function savedCredentialProviderIds(dataHome: string): Promise<Set<string> | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8')
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return new Set(Object.keys(parsed));
  } catch {
    return null;
  }
}

async function discoverModels(
  dataHome: string,
  runtime = DEFAULT_AUTH_RUNTIME
): Promise<OpenCodeModelCatalog> {
  await runtime.ensureOpenCodeDataHome(dataHome);
  await runtime.verifyOpenCodeAuthFileBoundary(dataHome, { allowMissing: true });
  return {
    runtimeVersion: OPENCODE_VERSION,
    ...createOpenCodeKnownModelCatalog(await savedCredentialProviderIds(dataHome)),
  };
}

function configuredPair(model: string | undefined): OpenCodeModelPair | undefined {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return {
    providerId: model.slice(0, separator),
    modelId: model.slice(separator + 1),
  };
}

async function readConfigurationSnapshot(
  client: V2Client,
  dataHome: string,
  directory: string
): Promise<OpenCodeProviderDiscovery> {
  const [modelsResponse, configResponse, providerResponse, authResponse, credentialProviderIds] =
    await Promise.all([
      client.config.providers({ directory }),
      client.config.get({ directory }),
      client.provider.list({ directory }),
      client.provider.auth({ directory }),
      savedCredentialProviderIds(dataHome),
    ]);
  if (
    modelsResponse.error ||
    !modelsResponse.data ||
    configResponse.error ||
    !configResponse.data ||
    providerResponse.error ||
    !providerResponse.data ||
    authResponse.error
  ) {
    throw new Error('OpenCode provider configuration discovery failed');
  }

  const modelProviders = new Map(
    modelsResponse.data.providers.map((provider) => [provider.id, provider] as const)
  );
  const runtimeProviders = new Map(
    providerResponse.data.all.map((provider) => [provider.id, provider] as const)
  );
  const providerIds = new Set([
    ...runtimeProviders.keys(),
    ...modelProviders.keys(),
    ...Object.keys(authResponse.data ?? {}),
    ...(credentialProviderIds ?? []),
  ]);
  const runtimeAvailable = new Set(providerResponse.data.connected);
  const providers = [...providerIds]
    .map((providerId): OpenCodeProviderConnection => {
      const modelProvider = modelProviders.get(providerId);
      const runtimeProvider = runtimeProviders.get(providerId);
      return {
        id: providerId,
        name: modelProvider?.name ?? runtimeProvider?.name ?? providerId,
        runtimeAvailable: runtimeAvailable.has(providerId),
        credentialPresence: credentialPresence(credentialProviderIds, providerId),
        authMethods: safeMethods(authResponse.data, providerId),
        ...(modelsResponse.data.default[providerId]
          ? { suggestedModel: modelsResponse.data.default[providerId] }
          : {}),
        models: modelProvider
          ? Object.values(modelProvider.models)
              .map((model) => ({
                id: model.id,
                name: model.name,
                status: model.status,
              }))
              .sort((left, right) => left.id.localeCompare(right.id))
          : [],
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const suggestedProvider = [
    ...providers.filter(
      (provider) => provider.runtimeAvailable && provider.credentialPresence === 'present'
    ),
    ...providers.filter(
      (provider) => provider.runtimeAvailable && provider.credentialPresence !== 'present'
    ),
  ].find(
    (provider) =>
      provider.suggestedModel &&
      provider.models.some(
        (model) => model.id === provider.suggestedModel && model.status === 'active'
      )
  );
  const projectConfigured = configuredPair(configResponse.data.model);
  const suggestedSelection =
    suggestedProvider?.suggestedModel === undefined
      ? undefined
      : {
          providerId: suggestedProvider.id,
          modelId: suggestedProvider.suggestedModel,
        };

  return {
    runtime: 'available',
    runtimeVersion: OPENCODE_VERSION,
    ...(projectConfigured ? { projectConfigured } : {}),
    ...(suggestedSelection ? { suggestedSelection } : {}),
    providers,
  };
}

async function discover(
  dataHome: string,
  directory = dataHome,
  runtime = DEFAULT_AUTH_RUNTIME
): Promise<OpenCodeProviderDiscovery> {
  return withFreshClient(
    dataHome,
    [],
    (client) => readConfigurationSnapshot(client, dataHome, directory),
    directory,
    runtime
  );
}

export async function handleOpenCodeAuth(
  payload: OpenCodeAuthPayload,
  options: OpenCodeCommandOptions,
  runtime = DEFAULT_AUTH_RUNTIME
) {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, operation: payload.params.operation },
    };
  }

  try {
    if (payload.params.operation === 'read-model-catalog') {
      return { success: true, data: await discoverModels(payload.dataHome, runtime) };
    }

    const unavailable = await runtimeUnavailableFailure(runtime);
    if (unavailable) return unavailable;

    if (payload.params.operation === 'discover') {
      return {
        success: true,
        data: await discover(
          payload.dataHome,
          payload.params.directory ?? payload.dataHome,
          runtime
        ),
      };
    }

    if (payload.params.operation === 'connect-oauth') {
      return {
        success: false,
        error: {
          code: 'OPENCODE_OAUTH_PROTOCOL_REQUIRED',
          message: 'OpenCode OAuth requires the bounded authorization protocol.',
        },
      };
    }

    const { providerId } = payload.params;
    const apiKey =
      payload.params.operation === 'connect-api-key' ? payload.params.apiKey : undefined;
    const metadata =
      payload.params.operation === 'connect-api-key' ? payload.params.metadata : undefined;
    const discovery = await withFreshClient(
      payload.dataHome,
      [apiKey ?? '', metadata],
      async (client) => {
        if (payload.params.operation === 'disconnect') {
          const savedProviders = await savedCredentialProviderIds(payload.dataHome);
          if (!savedProviders?.has(providerId)) {
            throw new Error('No saved OpenCode credential exists for that provider');
          }
        }
        const response =
          payload.params.operation === 'connect-api-key'
            ? await client.auth.set({
                providerID: providerId,
                auth: {
                  type: 'api',
                  key: payload.params.apiKey,
                  ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
                },
              })
            : await client.auth.remove({ providerID: providerId });
        if (response.error || response.data !== true) {
          throw new Error('OpenCode rejected the provider credential mutation');
        }
        await runtime.verifyOpenCodeAuthFileBoundary(payload.dataHome, {
          allowMissing: payload.params.operation === 'disconnect',
        });
        return readConfigurationSnapshot(client, payload.dataHome, payload.dataHome);
      },
      payload.dataHome,
      runtime
    );

    return { success: true, data: discovery };
  } catch {
    return {
      success: false,
      error: {
        code: 'OPENCODE_AUTH_FAILED',
        message: 'OpenCode provider operation failed without exposing credential details.',
      },
    };
  }
}

export type OpenCodeOAuthExecutorEvent =
  | { type: 'authorized'; authorization: OpenCodeOAuthAuthorization }
  | { type: 'callback-started' };

export type OpenCodeOAuthPayload = Omit<OpenCodeAuthPayload, 'params'> & {
  params: Extract<OpenCodeAuthPayload['params'], { operation: 'connect-oauth' }>;
};

const LOOPBACK_OAUTH_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function validateOpenCodeOAuthAuthorizationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OpenCode returned an invalid OAuth authorization URL');
  }
  if (url.username || url.password) {
    throw new Error('OpenCode returned an OAuth authorization URL with embedded credentials');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_OAUTH_HOSTS.has(url.hostname))
  ) {
    throw new Error('OpenCode returned an unsafe OAuth authorization URL');
  }
  return url.href;
}

export async function handleOpenCodeOAuth(
  payload: OpenCodeOAuthPayload,
  options: OpenCodeCommandOptions,
  emit: (event: OpenCodeOAuthExecutorEvent) => void,
  readCode?: () => Promise<string>,
  runtime = DEFAULT_AUTH_RUNTIME
) {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, operation: payload.params.operation },
    };
  }

  const unavailable = await runtimeUnavailableFailure(runtime);
  if (unavailable) return unavailable;

  const { providerId, method, inputs } = payload.params;
  try {
    const discovery = await withFreshClient(
      payload.dataHome,
      Object.values(inputs ?? {}),
      async (client) => {
        const response = await client.provider.oauth.authorize({
          providerID: providerId,
          method,
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
          directory: payload.dataHome,
        });
        if (response.error || !response.data) {
          throw new Error('OpenCode rejected OAuth authorization');
        }
        const authorization: OpenCodeOAuthAuthorization = {
          url: validateOpenCodeOAuthAuthorizationUrl(response.data.url),
          method: response.data.method,
          instructions: response.data.instructions,
        };
        emit({ type: 'authorized', authorization });
        const code = authorization.method === 'code' ? (await readCode?.())?.trim() : undefined;
        if (authorization.method === 'code' && !code) {
          throw new Error('OpenCode OAuth code was not supplied');
        }
        emit({ type: 'callback-started' });
        const callback = await client.provider.oauth.callback({
          providerID: providerId,
          method,
          ...(code ? { code } : {}),
          directory: payload.dataHome,
        });
        if (callback.error || callback.data !== true) {
          throw new Error('OpenCode rejected OAuth callback');
        }
        await runtime.verifyOpenCodeAuthFileBoundary(payload.dataHome);
        return readConfigurationSnapshot(client, payload.dataHome, payload.dataHome);
      },
      payload.dataHome,
      runtime
    );
    return { success: true, data: discovery };
  } catch {
    return {
      success: false,
      error: {
        code: 'OPENCODE_AUTH_FAILED',
        message: 'OpenCode provider operation failed without exposing credential details.',
      },
    };
  }
}
