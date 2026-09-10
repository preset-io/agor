import type {
  OpenCodeCatalogModel,
  OpenCodeCatalogProvider,
  OpenCodeModelCatalog,
  OpenCodeProviderConnection,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';

export const OPENCODE_VERSION = '1.14.33';

/**
 * Reviewed key-bearing providers offered in hosted (`managed-projection`)
 * deployments, mapped to the static encrypted field that stores each key in
 * the caller's per-tool credential bucket. Providers outside this map are
 * never projected, even if a field for them somehow exists.
 */
export const OPENCODE_HOSTED_PROVIDER_FIELDS = Object.freeze({
  anthropic: 'OPENCODE_API_KEY_ANTHROPIC',
  openai: 'OPENCODE_API_KEY_OPENAI',
  'kimi-for-coding': 'OPENCODE_API_KEY_KIMI_FOR_CODING',
} as const);

export type OpenCodeHostedProviderId = keyof typeof OPENCODE_HOSTED_PROVIDER_FIELDS;
export type OpenCodeHostedCredentialField =
  (typeof OPENCODE_HOSTED_PROVIDER_FIELDS)[OpenCodeHostedProviderId];

export function hostedCredentialFieldForProvider(
  providerId: string
): OpenCodeHostedCredentialField | undefined {
  return Object.hasOwn(OPENCODE_HOSTED_PROVIDER_FIELDS, providerId)
    ? OPENCODE_HOSTED_PROVIDER_FIELDS[providerId as OpenCodeHostedProviderId]
    : undefined;
}

/** Provider ids whose hosted key field is present (non-empty) in a resolved connection. */
export function hostedProviderIdsFromConnection(
  connection: Readonly<Record<string, string | boolean | undefined>>
): Set<string> {
  const saved = new Set<string>();
  for (const [providerId, field] of Object.entries(OPENCODE_HOSTED_PROVIDER_FIELDS)) {
    const value = connection[field];
    if (value === true || (typeof value === 'string' && value.trim())) saved.add(providerId);
  }
  return saved;
}

/**
 * Convert a resolved OpenCode connection into the `OPENCODE_AUTH_CONTENT`
 * map the pinned runtime reads in place of `auth.json`. Only reviewed
 * providers are projected. `secrets` lists every individual key so the
 * managed-server sanitizer can redact a bare key, not just the whole map.
 */
export function buildOpenCodeAuthContent(
  connection: Readonly<Record<string, string | undefined>>
): { content: string | undefined; providerIds: string[]; secrets: string[] } {
  const auth: Record<string, { type: 'api'; key: string }> = {};
  const secrets: string[] = [];
  for (const [providerId, field] of Object.entries(OPENCODE_HOSTED_PROVIDER_FIELDS)) {
    const key = connection[field]?.trim();
    if (!key) continue;
    auth[providerId] = { type: 'api', key };
    secrets.push(key);
  }
  const providerIds = Object.keys(auth);
  if (providerIds.length === 0) return { content: undefined, providerIds, secrets };
  const content = JSON.stringify(auth);
  return { content, providerIds, secrets: [...secrets, content] };
}

interface KnownProvider {
  id: string;
  name: string;
  availableWithoutCredentials: boolean;
  suggestedModel: string;
  models: readonly OpenCodeCatalogModel[];
}

const activeModels = (
  models: ReadonlyArray<readonly [id: string, name: string]>
): OpenCodeCatalogModel[] => models.map(([id, name]) => ({ id, name, status: 'active' }));

/** Curated against the OpenCode version pinned by this package. */
const KNOWN_PROVIDERS = [
  {
    id: 'kimi-for-coding',
    name: 'Kimi for Coding',
    availableWithoutCredentials: false,
    suggestedModel: 'k3',
    models: activeModels([
      ['k3', 'Kimi K3'],
      ['k3-256k', 'Kimi K3-256K'],
      ['kimi-for-coding', 'Kimi K2.7 Code'],
      ['kimi-for-coding-highspeed', 'Kimi For Coding HighSpeed'],
    ]),
  },
  {
    id: 'openai',
    name: 'OpenAI',
    availableWithoutCredentials: false,
    suggestedModel: 'gpt-5.6-terra-pro',
    models: activeModels([
      ['gpt-5.6-terra-pro', 'GPT-5.6 Terra Pro'],
      ['gpt-5.6-terra', 'GPT-5.6 Terra'],
      ['gpt-5.6-terra-fast', 'GPT-5.6 Terra Fast'],
      ['gpt-5.6-sol', 'GPT-5.6 Sol'],
      ['gpt-5.6-sol-fast', 'GPT-5.6 Sol Fast'],
      ['gpt-5.6-sol-pro', 'GPT-5.6 Sol Pro'],
      ['gpt-5.6-luna', 'GPT-5.6 Luna'],
      ['gpt-5.6-luna-fast', 'GPT-5.6 Luna Fast'],
      ['gpt-5.6-luna-pro', 'GPT-5.6 Luna Pro'],
      ['gpt-5.6', 'GPT-5.6'],
      ['gpt-5.6-fast', 'GPT-5.6 Fast'],
      ['gpt-5.6-pro', 'GPT-5.6 Pro'],
      ['gpt-5.5', 'GPT-5.5'],
      ['gpt-5.5-fast', 'GPT-5.5 Fast'],
      ['gpt-5.5-pro', 'GPT-5.5 Pro'],
      ['gpt-5.4', 'GPT-5.4'],
      ['gpt-5.4-fast', 'GPT-5.4 Fast'],
      ['gpt-5.4-mini', 'GPT-5.4 mini'],
      ['gpt-5.4-mini-fast', 'GPT-5.4 mini Fast'],
      ['gpt-5.3-codex', 'GPT-5.3 Codex'],
      ['gpt-5.2', 'GPT-5.2'],
    ]),
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    availableWithoutCredentials: false,
    suggestedModel: 'claude-sonnet-5',
    models: activeModels([
      ['claude-fable-5-1', 'Claude Fable 5.1'],
      ['claude-opus-5', 'Claude Opus 5'],
      ['claude-sonnet-5', 'Claude Sonnet 5'],
      ['claude-fable-5', 'Claude Fable 5'],
      ['claude-opus-4-8', 'Claude Opus 4.8'],
      ['claude-opus-4-7', 'Claude Opus 4.7'],
      ['claude-opus-4-6', 'Claude Opus 4.6'],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
      ['claude-opus-4-5', 'Claude Opus 4.5'],
      ['claude-sonnet-4-5', 'Claude Sonnet 4.5'],
      ['claude-haiku-4-5', 'Claude Haiku 4.5'],
    ]),
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    availableWithoutCredentials: true,
    suggestedModel: 'big-pickle',
    models: activeModels([
      ['big-pickle', 'Big Pickle'],
      ['deepseek-v4-flash-free', 'DeepSeek V4 Flash Free'],
      ['laguna-s-2.1-free', 'Laguna S 2.1 Free'],
      ['ling-3.0-flash-free', 'Ling 3.0 Flash Free'],
      ['mimo-v2.5-free', 'MiMo V2.5 Free'],
      ['nemotron-3-ultra-free', 'Nemotron 3 Ultra Free'],
      ['north-mini-code-free', 'North Mini Code Free'],
    ]),
  },
] as const satisfies readonly KnownProvider[];

function hasActiveSuggestedModel(provider: KnownProvider): boolean {
  return provider.models.some(
    (model) => model.id === provider.suggestedModel && model.status === 'active'
  );
}

/**
 * Returns immediate OpenCode choices without starting its native server.
 * Configured providers outside the curated list remain visible for exact entry.
 */
export function createOpenCodeKnownModelCatalog(
  credentialProviderIds: ReadonlySet<string> | null
): Omit<OpenCodeModelCatalog, 'runtimeVersion'> {
  const configuredProvider = credentialProviderIds
    ? KNOWN_PROVIDERS.find(
        (provider) => credentialProviderIds.has(provider.id) && hasActiveSuggestedModel(provider)
      )
    : undefined;
  const fallbackProvider = KNOWN_PROVIDERS.find(
    (provider) => provider.availableWithoutCredentials && hasActiveSuggestedModel(provider)
  );
  const suggestedProvider = configuredProvider ?? fallbackProvider;
  const knownIds = new Set<string>(KNOWN_PROVIDERS.map(({ id }) => id));
  const providers: OpenCodeCatalogProvider[] = KNOWN_PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    availableForSelection:
      provider.availableWithoutCredentials || credentialProviderIds?.has(provider.id) === true,
    suggestedModel: provider.suggestedModel,
    models: provider.models.map((model) => ({ ...model })),
  }));

  for (const id of credentialProviderIds ?? []) {
    if (!knownIds.has(id)) {
      providers.push({ id, name: id, availableForSelection: true, models: [] });
    }
  }

  return {
    ...(suggestedProvider
      ? {
          suggestedSelection: {
            providerId: suggestedProvider.id,
            modelId: suggestedProvider.suggestedModel,
          },
        }
      : {}),
    providers,
  };
}

/**
 * Provider settings for hosted deployments, derived from saved-key presence
 * without starting an OpenCode server. Every reviewed key-bearing provider
 * offers exactly one API-key method; OAuth is never listed. A saved key is
 * reported as present but is verified only by the first prompt.
 */
export function createOpenCodeHostedProviderDiscovery(
  savedProviderIds: ReadonlySet<string>
): OpenCodeProviderDiscovery {
  const providers: OpenCodeProviderConnection[] = KNOWN_PROVIDERS.map((provider) => {
    const hostedField = hostedCredentialFieldForProvider(provider.id);
    const saved = savedProviderIds.has(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      runtimeAvailable: provider.availableWithoutCredentials || saved,
      credentialPresence: saved ? 'present' : 'absent',
      authMethods: hostedField ? [{ index: 0, type: 'api', label: 'API key' }] : [],
      suggestedModel: provider.suggestedModel,
      models: provider.models.map((model) => ({ ...model })),
    };
  });
  const catalog = createOpenCodeKnownModelCatalog(savedProviderIds);
  return {
    runtime: 'available',
    runtimeVersion: OPENCODE_VERSION,
    ...(catalog.suggestedSelection ? { suggestedSelection: catalog.suggestedSelection } : {}),
    providers,
  };
}
