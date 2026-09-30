import type {
  OpenCodeCatalogModel,
  OpenCodeCatalogProvider,
  OpenCodeModelCatalog,
  OpenCodeProviderConnection,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';

export const OPENCODE_VERSION = '1.18.31';

/** Curated hosted providers and the encrypted user field that stores each key. */
export const OPENCODE_HOSTED_PROVIDER_FIELDS = Object.freeze({
  anthropic: 'OPENCODE_API_KEY_ANTHROPIC',
  openai: 'OPENCODE_API_KEY_OPENAI',
  'kimi-for-coding': 'OPENCODE_API_KEY_KIMI_FOR_CODING',
} as const);

type HostedProviderId = keyof typeof OPENCODE_HOSTED_PROVIDER_FIELDS;

export function hostedCredentialFieldForProvider(
  providerId: string
): (typeof OPENCODE_HOSTED_PROVIDER_FIELDS)[HostedProviderId] | undefined {
  return Object.hasOwn(OPENCODE_HOSTED_PROVIDER_FIELDS, providerId)
    ? OPENCODE_HOSTED_PROVIDER_FIELDS[providerId as HostedProviderId]
    : undefined;
}

/** Curated provider ids whose key is saved, from the user's public presence flags. */
export function hostedProviderIdsFromConnection(
  presence: Readonly<Record<string, boolean | undefined>>
): Set<string> {
  return new Set(
    Object.entries(OPENCODE_HOSTED_PROVIDER_FIELDS)
      .filter(([, field]) => presence[field])
      .map(([providerId]) => providerId)
  );
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
      ['claude-opus-5-5', 'Claude Opus 5.5'],
      ['claude-opus-5', 'Claude Opus 5'],
      ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
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
  credentialProviderIds: ReadonlySet<string> | null,
  options: {
    /** Hosted mode passes false: every turn needs a saved key, so Zen is never offered. */
    allowCredentialless?: boolean;
  } = {}
): Omit<OpenCodeModelCatalog, 'runtimeVersion'> {
  const allowCredentialless = options.allowCredentialless ?? true;
  const configuredProvider = credentialProviderIds
    ? KNOWN_PROVIDERS.find(
        (provider) => credentialProviderIds.has(provider.id) && hasActiveSuggestedModel(provider)
      )
    : undefined;
  const fallbackProvider = allowCredentialless
    ? KNOWN_PROVIDERS.find(
        (provider) => provider.availableWithoutCredentials && hasActiveSuggestedModel(provider)
      )
    : undefined;
  const suggestedProvider = configuredProvider ?? fallbackProvider;
  const knownIds = new Set<string>(KNOWN_PROVIDERS.map(({ id }) => id));
  const providers: OpenCodeCatalogProvider[] = KNOWN_PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    availableForSelection:
      (allowCredentialless && provider.availableWithoutCredentials) ||
      credentialProviderIds?.has(provider.id) === true,
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

/** Hosted provider settings from saved-key presence: API keys only, verified by the first prompt. */
export function createOpenCodeHostedProviderDiscovery(
  savedProviderIds: ReadonlySet<string>
): OpenCodeProviderDiscovery {
  const providers: OpenCodeProviderConnection[] = KNOWN_PROVIDERS.map((provider) => {
    const hostedField = hostedCredentialFieldForProvider(provider.id);
    const saved = savedProviderIds.has(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      // Managed projection requires a saved curated key for every turn; a
      // credential-less provider is therefore not available in hosted mode.
      runtimeAvailable: saved,
      credentialPresence: saved ? 'present' : 'absent',
      authMethods: hostedField ? [{ index: 0, type: 'api', label: 'API key' }] : [],
      suggestedModel: provider.suggestedModel,
      models: provider.models.map((model) => ({ ...model })),
    };
  });
  const catalog = createOpenCodeKnownModelCatalog(savedProviderIds, {
    allowCredentialless: false,
  });
  return {
    runtime: 'available',
    runtimeVersion: OPENCODE_VERSION,
    ...(catalog.suggestedSelection ? { suggestedSelection: catalog.suggestedSelection } : {}),
    providers,
  };
}
