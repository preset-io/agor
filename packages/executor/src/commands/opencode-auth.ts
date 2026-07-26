import type {
  OpenCodeOAuthAuthorization,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderConnection,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { OpenCodeAuthPayload } from '../payload-types.js';
import {
  OPENCODE_VERSION,
  startManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary,
} from '../sdk-handlers/opencode/managed-server.js';
import type { CommandOptions } from './index.js';

type V2Client = ReturnType<typeof createOpencodeClient>;

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
          prompts: method.prompts.map((prompt) =>
            prompt.type === 'select'
              ? {
                  type: prompt.type,
                  key: prompt.key,
                  message: prompt.message,
                  options: prompt.options.map(({ label, value, hint }) => ({
                    label,
                    value,
                    ...(hint ? { hint } : {}),
                  })),
                  ...(prompt.when ? { when: prompt.when } : {}),
                }
              : {
                  type: prompt.type,
                  key: prompt.key,
                  message: prompt.message,
                  ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
                  ...(prompt.when ? { when: prompt.when } : {}),
                }
          ),
        }
      : {}),
  }));
}

async function withFreshClient<T>(
  dataHome: string,
  secrets: readonly unknown[],
  work: (client: V2Client) => Promise<T>
): Promise<T> {
  const server = await startManagedOpenCodeServer({ directory: dataHome, dataHome, secrets });
  const client = createOpencodeClient({
    baseUrl: server.baseUrl,
    directory: dataHome,
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
    await client.instance.dispose({ directory: dataHome });
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

async function discover(dataHome: string): Promise<OpenCodeProviderDiscovery> {
  return withFreshClient(dataHome, [], async (client) => {
    const [providerResponse, authResponse] = await Promise.all([
      client.provider.list({ directory: dataHome }),
      client.provider.auth({ directory: dataHome }),
    ]);
    if (providerResponse.error || !providerResponse.data || authResponse.error) {
      throw new Error('OpenCode provider discovery failed');
    }
    const connected = new Set(providerResponse.data.connected);
    const providers = providerResponse.data.all.map(
      (provider): OpenCodeProviderConnection => ({
        id: provider.id,
        name: provider.name,
        configured: connected.has(provider.id),
        status: connected.has(provider.id) ? 'configured' : 'disconnected',
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
