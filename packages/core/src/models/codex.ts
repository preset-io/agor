/**
 * Codex Model Constants
 *
 * OpenAI Codex model identifiers and defaults
 */

/** Default Codex model */
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';

/** Codex Mini model for cost-effective usage */
export const CODEX_MINI_MODEL = 'gpt-5.4-mini';

export type CodexModelStatus = 'current' | 'known';
export type CodexModelAvailability = 'supported' | 'not-selectable' | 'unsupported';

export type CodexModelLifecycleMetadata = {
  name: string;
  description: string;
  status: CodexModelStatus;
  selectable: boolean;
  availability: CodexModelAvailability;
  replacement?: string;
};

/**
 * Lifecycle-aware model registry (single source of truth).
 *
 * Order matters — selectable entries are surfaced in this order.
 *
 * Uses `as const satisfies` to preserve literal key types for CodexModel.
 */
const _CODEX_MODEL_REGISTRY = {
  // GPT-5.5 models (newest frontier model)
  'gpt-5.5': {
    name: 'GPT-5.5 (Recommended)',
    description:
      "OpenAI's newest frontier model for complex coding, computer use, knowledge work, and research workflows in Codex.",
    status: 'current',
    selectable: true,
    availability: 'supported',
  },
  'gpt-5.5-pro': {
    name: 'GPT-5.5 Pro',
    description: 'Higher-compute GPT-5.5 variant for the toughest professional work',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  // GPT-5.4 models
  'gpt-5.4': {
    name: 'GPT-5.4',
    description: 'Frontier model for professional work with strong coding and agentic workflows',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-5.4-pro': {
    name: 'GPT-5.4 Pro',
    description: 'Higher-compute GPT-5.4 variant for difficult reasoning tasks',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-5.4-mini': {
    name: 'GPT-5.4 Mini',
    description: 'Fast, efficient model for responsive coding tasks and subagents',
    status: 'current',
    selectable: true,
    availability: 'supported',
  },
  'gpt-5.4-nano': {
    name: 'GPT-5.4 Nano',
    description: 'Lowest-cost GPT-5.4-class model for simple high-volume tasks and subagents',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: CODEX_MINI_MODEL,
  },
  // GPT-5.3 models
  'gpt-5.3-codex': {
    name: 'GPT-5.3 Codex',
    description: 'Previous Codex coding model.',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-5.3-codex-spark': {
    name: 'GPT-5.3 Codex Spark',
    description: 'Real-time coding model, 1000+ tokens/sec (Pro users)',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: CODEX_MINI_MODEL,
  },
  // GPT-5.2 models
  'gpt-5.2-codex': {
    name: 'GPT-5.2 Codex',
    description: 'Previous coding model optimized for agentic tasks - 400k context',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-5.2': {
    name: 'GPT-5.2',
    description: 'Previous frontier model for complex tasks - 400k context, thinking mode',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-5.2-pro': {
    name: 'GPT-5.2 Pro',
    description: 'Highest accuracy, xhigh reasoning for difficult problems',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-5.2-instant': {
    name: 'GPT-5.2 Instant',
    description: 'Faster model for writing and information seeking',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: CODEX_MINI_MODEL,
  },
  // GPT-5.1 models
  'gpt-5.1-codex-max': {
    name: 'GPT-5.1 Codex Max',
    description: 'Previous model optimized for long-horizon agentic coding',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-5.1-codex': {
    name: 'GPT-5.1 Codex',
    description: 'Previous model optimized for agentic coding tasks',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-5.1-codex-mini': {
    name: 'GPT-5.1 Codex Mini',
    description: 'Previous cost-effective Codex variant',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: CODEX_MINI_MODEL,
  },
  'gpt-5.1': {
    name: 'GPT-5.1',
    description: 'General purpose GPT-5.1 model',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  // GPT-5 models (legacy)
  'gpt-5-codex': {
    name: 'GPT-5 Codex',
    description: 'Legacy model for software engineering',
    status: 'known',
    selectable: false,
    availability: 'unsupported',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-5-codex-mini': {
    name: 'GPT-5 Codex Mini',
    description: 'Legacy faster, lighter model',
    status: 'known',
    selectable: false,
    availability: 'unsupported',
    replacement: CODEX_MINI_MODEL,
  },
  'gpt-5': {
    name: 'GPT-5',
    description: 'Legacy general purpose model',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  // GPT-4o models
  'gpt-4o': {
    name: 'GPT-4o',
    description: 'General purpose model',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: DEFAULT_CODEX_MODEL,
  },
  'gpt-4o-mini': {
    name: 'GPT-4o Mini',
    description: 'Smaller, faster model',
    status: 'known',
    selectable: false,
    availability: 'not-selectable',
    replacement: CODEX_MINI_MODEL,
  },
} as const satisfies Record<string, CodexModelLifecycleMetadata>;

export const CODEX_MODEL_REGISTRY = _CODEX_MODEL_REGISTRY;

export const CODEX_MODEL_METADATA = Object.fromEntries(
  Object.entries(CODEX_MODEL_REGISTRY)
    .filter(([, meta]) => meta.selectable)
    .map(([id, meta]) => [id, { name: meta.name, description: meta.description }])
) as PickSelectableCodexModelMetadata<typeof CODEX_MODEL_REGISTRY>;

type PickSelectableCodexModelMetadata<T extends Record<string, CodexModelLifecycleMetadata>> = {
  [K in keyof T as T[K]['selectable'] extends true ? K : never]: {
    name: T[K]['name'];
    description: T[K]['description'];
  };
};

/** All known Codex model IDs (literal union) */
export type CodexModel = keyof typeof _CODEX_MODEL_REGISTRY;

/** Selectable model aliases for Codex (derived from metadata) */
export const CODEX_MODELS = Object.fromEntries(
  Object.keys(CODEX_MODEL_METADATA).map((id) => [id, id])
) as Record<keyof typeof CODEX_MODEL_METADATA, keyof typeof CODEX_MODEL_METADATA>;

export function getCodexModelLifecycle(model?: string): CodexModelLifecycleMetadata | undefined {
  if (!model) return undefined;

  const normalized = model.toLowerCase();
  if (CODEX_MODEL_REGISTRY[normalized as CodexModel]) {
    return CODEX_MODEL_REGISTRY[normalized as CodexModel];
  }

  const longestFirstEntries = Object.entries(CODEX_MODEL_REGISTRY).sort(
    ([a], [b]) => b.length - a.length
  );
  for (const [id, meta] of longestFirstEntries) {
    if (normalized.startsWith(`${id}-`)) {
      return meta;
    }
  }

  return undefined;
}

export function isUnsupportedAgorCodexModel(model?: string): boolean {
  return getCodexModelLifecycle(model)?.availability === 'unsupported';
}

export function formatUnsupportedAgorCodexModelMessage(model: string): string {
  const lifecycle = getCodexModelLifecycle(model);
  const replacement = lifecycle?.replacement ?? DEFAULT_CODEX_MODEL;
  return `Codex model "${model}" is a legacy alias that is not supported for Agor Codex sessions. Remove it from the request, parent session, or user defaults; omit modelConfig to use the default (${DEFAULT_CODEX_MODEL}) or use "${replacement}".`;
}

const DEFAULT_CODEX_CONTEXT_LIMIT = 200_000;

/**
 * Best-effort limits for known Codex-compatible OpenAI models.
 * Unknown models fall back to 200k.
 */
export const CODEX_CONTEXT_LIMITS: Record<string, number> = {
  // GPT-5.5 models
  'gpt-5.5': 1_050_000,
  'gpt-5.5-pro': 1_050_000,
  // GPT-5.4 models
  'gpt-5.4': 1_050_000,
  'gpt-5.4-pro': 1_050_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.4-nano': 400_000,
  // GPT-5.3 models
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 128_000,
  // GPT-5.2 models (400k context, 128k max output)
  'gpt-5.2-codex': 400_000,
  'gpt-5.2': 400_000,
  'gpt-5.2-pro': 400_000,
  'gpt-5.2-instant': 400_000,
  // GPT-5.1 models
  'gpt-5.1-codex-max': 200_000,
  'gpt-5.1-codex': 200_000,
  'gpt-5.1-codex-mini': 200_000,
  'gpt-5.1': 200_000,
  // GPT-5 models (legacy)
  'gpt-5-codex': 400_000,
  'gpt-5-codex-mini': 200_000,
  'gpt-5': 200_000,
  // GPT-4o models
  'gpt-4o': 128_000,
  'gpt-4o-mini': 64_000,
};

export function getCodexContextWindowLimit(model?: string): number {
  if (!model) return DEFAULT_CODEX_CONTEXT_LIMIT;

  const normalized = model.toLowerCase();
  if (CODEX_CONTEXT_LIMITS[normalized]) {
    return CODEX_CONTEXT_LIMITS[normalized];
  }

  for (const [key, limit] of Object.entries(CODEX_CONTEXT_LIMITS)) {
    if (normalized.startsWith(`${key}-`)) {
      return limit;
    }
  }

  return DEFAULT_CODEX_CONTEXT_LIMIT;
}
