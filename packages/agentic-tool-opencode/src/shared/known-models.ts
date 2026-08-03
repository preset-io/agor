import type {
  OpenCodeCatalogModel,
  OpenCodeCatalogProvider,
  OpenCodeModelCatalog,
} from '@agor/core/types';

interface KnownProvider {
  id: string;
  name: string;
  availableWithoutCredentials: boolean;
  suggestedModel: string;
  models: readonly OpenCodeCatalogModel[];
}

const KNOWN_PROVIDERS = [
  {
    id: 'kimi-for-coding',
    name: 'Kimi for Coding',
    availableWithoutCredentials: false,
    suggestedModel: 'k3',
    models: [
      { id: 'k3', name: 'Kimi K3', status: 'active' },
      { id: 'k3-256k', name: 'Kimi K3-256K', status: 'active' },
      { id: 'kimi-for-coding', name: 'Kimi K2.7 Code', status: 'active' },
      {
        id: 'kimi-for-coding-highspeed',
        name: 'Kimi For Coding HighSpeed',
        status: 'active',
      },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    availableWithoutCredentials: true,
    suggestedModel: 'big-pickle',
    models: [
      { id: 'big-pickle', name: 'Big Pickle', status: 'active' },
      { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', status: 'active' },
      { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 Free', status: 'active' },
      { id: 'ling-3.0-flash-free', name: 'Ling 3.0 Flash Free', status: 'active' },
      { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', status: 'active' },
      { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', status: 'active' },
      { id: 'north-mini-code-free', name: 'North Mini Code Free', status: 'active' },
    ],
  },
] as const satisfies readonly KnownProvider[];

function hasActiveSuggestedModel(provider: KnownProvider): boolean {
  return provider.models.some(
    (model) => model.id === provider.suggestedModel && model.status === 'active'
  );
}

/**
 * Returns Agor's curated OpenCode choices without starting a native server.
 * Unlisted exact pairs remain valid inputs and are checked by the task runtime.
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
  const providers: OpenCodeCatalogProvider[] = KNOWN_PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    runtimeAvailable:
      provider.availableWithoutCredentials || credentialProviderIds?.has(provider.id) === true,
    suggestedModel: provider.suggestedModel,
    models: provider.models.map((model) => ({ ...model })),
  }));

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
