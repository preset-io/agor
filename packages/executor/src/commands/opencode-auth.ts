import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPENCODE_VERSION,
  startManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary,
} from '@agor/agentic-tools/opencode/runtime';
import type {
  OpenCodeModelCatalog,
  OpenCodeOAuthAuthorization,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderConnection,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { OpenCodeAuthPayload } from '../payload-types.js';
import type { CommandOptions } from './index.js';

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
  directory = dataHome
): Promise<T> {
  const server = await startManagedOpenCodeServer({
    directory,
    dataHome,
    secrets: [...secrets, directory],
  });
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

function configuredPair(model: string | undefined): OpenCodeModelCatalog['projectConfigured'] {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return {
    providerId: model.slice(0, separator),
    modelId: model.slice(separator + 1),
  };
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
  directory = dataHome
): Promise<OpenCodeModelCatalog> {
  return withFreshClient(
    dataHome,
    [],
    async (client) => {
      const [providersResponse, configResponse, runtimeProvidersResponse] = await Promise.all([
        client.config.providers({ directory }),
        client.config.get({ directory }),
        client.provider.list({ directory }),
      ]);
      if (
        providersResponse.error ||
        !providersResponse.data ||
        configResponse.error ||
        !configResponse.data ||
        runtimeProvidersResponse.error ||
        !runtimeProvidersResponse.data
      ) {
        throw new Error('OpenCode configured model discovery failed');
      }
      const runtimeAvailable = new Set(runtimeProvidersResponse.data.connected);
      const providers = providersResponse.data.providers
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          runtimeAvailable: runtimeAvailable.has(provider.id),
          ...(providersResponse.data.default[provider.id]
            ? { suggestedModel: providersResponse.data.default[provider.id] }
            : {}),
          models: Object.values(provider.models)
            .map((model) => ({
              id: model.id,
              name: model.name,
              status: model.status,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const projectConfigured = configuredPair(configResponse.data.model);
      return {
        runtimeVersion: OPENCODE_VERSION,
        ...(projectConfigured ? { projectConfigured } : {}),
        providers,
      };
    },
    directory
  );
}

async function discover(dataHome: string): Promise<OpenCodeProviderDiscovery> {
  return withFreshClient(dataHome, [], async (client) => {
    const [providerResponse, authResponse, credentialProviderIds] = await Promise.all([
      client.provider.list({ directory: dataHome }),
      client.provider.auth({ directory: dataHome }),
      savedCredentialProviderIds(dataHome),
    ]);
    if (providerResponse.error || !providerResponse.data || authResponse.error) {
      throw new Error('OpenCode provider discovery failed');
    }
    const connected = new Set(providerResponse.data.connected);
    const providers = providerResponse.data.all.map(
      (provider): OpenCodeProviderConnection => ({
        id: provider.id,
        name: provider.name,
        runtimeAvailable: connected.has(provider.id),
        credentialPresence: credentialPresence(credentialProviderIds, provider.id),
        authMethods: safeMethods(authResponse.data, provider.id),
      })
    );
    return { runtime: 'available', runtimeVersion: OPENCODE_VERSION, providers };
  });
}

export async function handleOpenCodeAuth(payload: OpenCodeAuthPayload, options: CommandOptions) {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: payload.command, operation: payload.params.operation },
    };
  }

  try {
    if (payload.params.operation === 'discover-models') {
      return {
        success: true,
        data: await discoverModels(payload.dataHome, payload.params.directory),
      };
    }

    if (payload.params.operation === 'discover') {
      return { success: true, data: await discover(payload.dataHome) };
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
    await withFreshClient(payload.dataHome, [apiKey ?? '', metadata], async (client) => {
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
      await verifyOpenCodeAuthFileBoundary(payload.dataHome, {
        allowMissing: payload.params.operation === 'disconnect',
      });
    });

    return { success: true, data: await discover(payload.dataHome) };
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

export async function handleOpenCodeOAuth(
  payload: OpenCodeOAuthPayload,
  options: CommandOptions,
  emit: (event: OpenCodeOAuthExecutorEvent) => void,
  readCode?: () => Promise<string>
) {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: payload.command, operation: payload.params.operation },
    };
  }

  const { providerId, method, inputs } = payload.params;
  try {
    const mutation = await withFreshClient(
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
          url: response.data.url,
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
        await verifyOpenCodeAuthFileBoundary(payload.dataHome);
        return true;
      }
    );
    if (!mutation) throw new Error('OpenCode OAuth mutation did not complete');
    return { success: true, data: await discover(payload.dataHome) };
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
