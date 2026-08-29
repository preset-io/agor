import type {
  OpenCodeCatalogModel,
  OpenCodeCatalogProvider,
  OpenCodeModelCatalog,
} from '@agor/core/types';

export const OPENCODE_VERSION = '1.14.33';

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
    // Active lineup captured from the pinned runtime's post-connect catalog
    // (models.dev-backed) on 2026-08-29; suggestedModel matches its default.
    id: 'opencode-go',
    name: 'OpenCode Go',
    availableWithoutCredentials: false,
    suggestedModel: 'gpt-5.6-luna',
    models: activeModels([
      ['gpt-5.6-luna', 'GPT-5.6 Luna'],
      ['deepseek-v4-flash', 'DeepSeek V4 Flash'],
      ['deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Exp'],
      ['deepseek-v4-pro', 'DeepSeek V4 Pro (New)'],
      ['glm-5.1', 'GLM-5.1'],
      ['glm-5.2', 'GLM-5.2'],
      ['glm-5.3', 'GLM-5.3'],
      ['glm-5.3-flash', 'GLM-5.3-Flash (2x usage)'],
      ['grok-4.6', 'Grok 4.6'],
      ['hy3', 'Hy3 (8x usage)'],
      ['hy4-preview', 'Hy4 preview'],
      ['kimi-k2.6', 'Kimi K2.6'],
      ['kimi-k2.7-code', 'Kimi K2.7 Code'],
      ['kimi-k3', 'Kimi K3'],
      ['longcat-2.0', 'LongCat-2.0'],
      ['mimo-v2.5', 'MiMo V2.5'],
      ['mimo-v2.5-pro', 'MiMo V2.5 Pro'],
      ['minimax-m2.7', 'MiniMax-M2.7'],
      ['minimax-m3', 'MiniMax-M3'],
      ['muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor'],
      ['qwen3.6-plus', 'Qwen3.6 Plus'],
      ['qwen3.7-max', 'Qwen3.7 Max'],
      ['qwen3.7-plus', 'Qwen3.7 Plus'],
      ['qwen3.8-flash', 'Qwen3.8 Flash'],
      ['qwen3.8-max', 'Qwen3.8 Max'],
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
