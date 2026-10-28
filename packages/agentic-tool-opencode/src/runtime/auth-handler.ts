import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  OpenCodeModelCatalog,
  OpenCodeModelPair,
  OpenCodeModelStatus,
  OpenCodeOAuthAuthorization,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderAuthPrompt,
  OpenCodeProviderAuthPromptCondition,
  OpenCodeProviderConnection,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';
import { createOpenCodeKnownModelCatalog } from '../shared/known-models.js';
import type { OpenCodeAuthPayload } from './auth-payload.js';
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
}

const DEFAULT_AUTH_RUNTIME: OpenCodeAuthRuntimeDependencies = {
  ensureOpenCodeDataHome: defaultEnsureOpenCodeDataHome,
  startManagedOpenCodeServer: defaultStartManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary: defaultVerifyOpenCodeAuthFileBoundary,
};

// biome-ignore lint/suspicious/noExplicitAny: OpenCode client dynamically supports v1 and v2 SDK methods
type V2Client = any;

type RawPrompt = {
  key?: string;
  type?: string;
  title?: string;
  message?: string;
  placeholder?: string;
  when?: { key?: string };
  options?: Array<{ label?: string; value: string; hint?: string }>;
};

function safeAuthPrompt(raw: unknown): OpenCodeProviderAuthPrompt {
  const prompt = (raw && typeof raw === 'object' ? raw : {}) as RawPrompt;
  const key = prompt.key ?? 'key';
  const label = prompt.message ?? prompt.title ?? key;
  const condition =
    prompt.when && typeof prompt.when.key === 'string'
      ? { when: prompt.when as OpenCodeProviderAuthPromptCondition }
      : {};
  if (prompt.type === 'select' && Array.isArray(prompt.options)) {
    return {
      type: 'select',
      key,
      message: label,
      options: prompt.options.map(({ label: optLabel, value, hint }) => ({
        label: optLabel ?? value,
        value,
        ...(hint ? { hint } : {}),
      })),
      ...condition,
    };
  }
  return {
    type: 'text',
    key,
    message: label,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
    ...condition,
  };
}

function safeMethods(
  methods: Record<string, Array<{ type: string; label?: string; prompts?: unknown[] }>> | undefined,
  providerId: string
): OpenCodeProviderAuthMethod[] {
  return (
    (methods?.[providerId] ?? []) as Array<{
      type: string;
      label?: string;
      prompts?: unknown[];
    }>
  ).map((method, index: number) => ({
    index,
    type: (method.type === 'oauth' ? 'oauth' : 'api') as 'api' | 'oauth',
    label: method.label ?? (method.type === 'oauth' ? 'OAuth' : 'API Key'),
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
  const sdk = (await loadOpenCodeSdkV2()) as unknown as {
    createOpencodeClient?: (opts: unknown) => V2Client;
    OpenCode?: { make: (opts: unknown) => V2Client };
  };
  const createClient =
    sdk.createOpencodeClient ?? ((opts: unknown) => (sdk.OpenCode?.make(opts) ?? {}) as V2Client);
  const client = createClient({
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
    if (client.instance && typeof client.instance.dispose === 'function') {
      await client.instance.dispose({ directory });
    }
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
  let ids: Set<string> | null = null;
  try {
    const parsed = JSON.parse(
      await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8')
    ) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      ids = new Set(Object.keys(parsed));
    }
  } catch {
    // auth.json missing or invalid
  }

  try {
    const dbPath = join(dataHome, 'opencode', 'opencode.db');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
        .get();
      if (table) {
        if (!ids) ids = new Set();
        const rows = db
          .prepare(
            'SELECT DISTINCT coalesce(integration_id, connector_id) AS id FROM credential WHERE coalesce(integration_id, connector_id) IS NOT NULL'
          )
          .all() as Array<{ id?: string }>;
        for (const row of rows) {
          if (row?.id) ids.add(row.id);
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // opencode.db missing or invalid
  }

  return ids;
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
  if (client.integration && typeof client.integration.list === 'function') {
    const [integrationsResponse, modelsResponse, _configResponse, credentialProviderIds] =
      await Promise.all([
        client.integration.list({ location: { directory } }),
        client.model && typeof client.model.list === 'function'
          ? client.model.list({ location: { directory } })
          : Promise.resolve({ data: [] }),
        client.config && typeof client.config.get === 'function'
          ? client.config.get({ location: { directory } }).catch(() => ({ data: {} }))
          : Promise.resolve({ data: {} }),
        savedCredentialProviderIds(dataHome),
      ]);
    const integrations = integrationsResponse?.data ?? [];
    const models = modelsResponse?.data ?? [];

    type RawIntegration = {
      id: string;
      name?: string;
      connections?: unknown[];
      methods?: Array<{
        type?: string;
        label?: string;
        name?: string;
        form?: unknown[];
        prompts?: unknown[];
      }>;
    };
    type RawModel = {
      providerID?: string;
      canonical?: string;
      id?: string;
      modelID?: string;
      name?: string;
      status?: string;
    };
    const providers: OpenCodeProviderConnection[] = (integrations as RawIntegration[]).map(
      (integration) => {
        const providerModels = (models as RawModel[])
          .filter((m) => m.providerID === integration.id || m.canonical === integration.id)
          .map((m) => ({
            id: m.id || m.modelID || 'unknown',
            name: m.name || m.id || 'unknown',
            status: (m.status as OpenCodeModelStatus) || 'active',
          }));
        const hasConnection = Boolean((integration.connections?.length ?? 0) > 0);
        const interactiveMethods = (integration.methods || []).filter(
          (method) => method.type !== 'env'
        );
        const resolvedMethods = (
          interactiveMethods.length > 0 ? interactiveMethods : [{ type: 'key', label: 'API Key' }]
        ).map((method, index: number) => ({
          index,
          type: (method.type === 'oauth' ? 'oauth' : 'api') as 'api' | 'oauth',
          label: method.label || method.name || (method.type === 'oauth' ? 'OAuth' : 'API Key'),
          ...(method.prompts || method.form
            ? {
                prompts: (((method.prompts || method.form) ?? []) as unknown[]).map(safeAuthPrompt),
              }
            : {}),
        }));
        return {
          id: integration.id,
          name: integration.name || integration.id,
          runtimeAvailable: hasConnection,
          credentialPresence: hasConnection
            ? 'present'
            : credentialPresence(credentialProviderIds, integration.id),
          authMethods: resolvedMethods,
          suggestedModel: providerModels[0]?.id,
          models: providerModels,
        };
      }
    );

    const suggestedProvider =
      providers.find(
        (p) => p.runtimeAvailable && p.credentialPresence === 'present' && p.suggestedModel
      ) ?? providers.find((p) => p.runtimeAvailable && p.suggestedModel);

    return {
      runtime: 'available',
      runtimeVersion: OPENCODE_VERSION,
      providers,
      suggestedSelection: suggestedProvider?.suggestedModel
        ? { providerId: suggestedProvider.id, modelId: suggestedProvider.suggestedModel }
        : undefined,
    };
  }

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

  const modelProviders = new Map<
    string,
    {
      id: string;
      name?: string;
      models: Record<string, { id: string; name: string; status: string }>;
    }
  >(
    (
      (modelsResponse.data.providers ?? []) as Array<{
        id: string;
        name?: string;
        models: Record<string, { id: string; name: string; status: string }>;
      }>
    ).map((provider) => [provider.id, provider] as const)
  );
  const runtimeProviders = new Map<string, { id: string; name?: string }>(
    ((providerResponse.data.all ?? []) as Array<{ id: string; name?: string }>).map(
      (provider) => [provider.id, provider] as const
    )
  );
  const providerIds = new Set<string>([
    ...runtimeProviders.keys(),
    ...modelProviders.keys(),
    ...Object.keys(authResponse.data ?? {}),
    ...(credentialProviderIds ?? []),
  ]);
  const runtimeAvailable = new Set<string>(providerResponse.data.connected ?? []);
  const defaultModels = (modelsResponse.data.default ?? {}) as Record<string, string>;
  const providers = [...providerIds]
    .map((providerId: string): OpenCodeProviderConnection => {
      const modelProvider = modelProviders.get(providerId);
      const runtimeProvider = runtimeProviders.get(providerId);
      return {
        id: providerId,
        name: modelProvider?.name ?? runtimeProvider?.name ?? providerId,
        runtimeAvailable: runtimeAvailable.has(providerId),
        credentialPresence: credentialPresence(credentialProviderIds, providerId),
        authMethods: safeMethods(authResponse.data, providerId),
        ...(defaultModels[providerId] ? { suggestedModel: defaultModels[providerId] } : {}),
        models: modelProvider
          ? Object.values(modelProvider.models)
              .map((model: { id: string; name: string; status: string }) => ({
                id: model.id,
                name: model.name,
                status: (model.status as OpenCodeModelStatus) || 'active',
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

    if (payload.params.operation === 'read-model-catalog') {
      return { success: true, data: await discoverModels(payload.dataHome, runtime) };
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
          let hasCredential = Boolean(savedProviders?.has(providerId));
          if (!hasCredential && client.credential && typeof client.credential.list === 'function') {
            const list = await client.credential.list().catch(() => []);
            hasCredential = (list as Array<{ integrationID?: string }>).some(
              (c) => c.integrationID === providerId
            );
          }
          if (!hasCredential) {
            throw new Error('No saved OpenCode credential exists for that provider');
          }
        }
        if (payload.params.operation === 'connect-api-key') {
          if (client.credential && typeof client.credential.create === 'function') {
            await client.credential.create({
              integrationID: providerId,
              label: `${providerId}-api-key`,
              value: { type: 'key', key: payload.params.apiKey },
            });
          } else {
            const response = await client.auth.set({
              providerID: providerId,
              auth: {
                type: 'api',
                key: payload.params.apiKey,
                ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
              },
            });
            if (response.error || response.data !== true) {
              throw new Error('OpenCode rejected the provider credential mutation');
            }
          }
        } else {
          if (
            client.credential &&
            typeof client.credential.list === 'function' &&
            typeof client.credential.remove === 'function'
          ) {
            const list = await client.credential.list();
            for (const item of list.filter(
              (c: { integrationID?: string; id?: string }) => c.integrationID === providerId
            )) {
              await client.credential.remove({ credentialID: item.id });
            }
          } else {
            const response = await client.auth.remove({ providerID: providerId });
            if (response.error || response.data !== true) {
              throw new Error('OpenCode rejected the provider credential mutation');
            }
          }
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
