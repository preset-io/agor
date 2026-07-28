import type { AgenticToolName } from '@agor-live/client';
import {
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  CODEX_MODEL_METADATA,
  COPILOT_MODEL_METADATA,
  CURSOR_MODEL_METADATA,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_CURSOR_MODEL,
  GEMINI_MODELS,
  getDefaultModelForTool,
} from '@agor-live/client';

export { DEFAULT_CURSOR_MODEL };

export interface ModelOptionLike {
  id: string;
}

const CLAUDE_TOOLS = new Set<AgenticToolName>(['claude-code']);

/** Common option shape the picker renders: a friendly name plus optional blurb. */
export interface NormalizedModelOption {
  id: string;
  displayName: string;
  description?: string;
  availability?: 'supported' | 'provider-dependent' | 'unsupported';
}

/** The picker's upstream lists disagree on the name field (`displayName` vs `label`). */
type LooseModelOption = {
  id: string;
  displayName?: string;
  label?: string;
  description?: string;
  availability?: 'supported' | 'provider-dependent' | 'unsupported';
};

export function normalizeModelOption(model: LooseModelOption): NormalizedModelOption {
  return {
    id: model.id,
    displayName: model.displayName ?? model.label ?? model.id,
    description: model.description,
    availability: model.availability,
  };
}

/**
 * Preserve the complete selectable alias list supplied by the tool's static or
 * dynamic discovery source, surfacing the default/recommended model first.
 *
 * Provider discovery is responsible for excluding unsuitable entries such as
 * Claude's dated snapshots. Users can still pin an unlisted provider model ID
 * through exact mode.
 */
export function curateModelOptions(
  _tool: AgenticToolName,
  models: NormalizedModelOption[],
  defaultModel: string
): NormalizedModelOption[] {
  const defaultIndex = models.findIndex((model) => model.id === defaultModel);
  if (defaultIndex <= 0) return models;
  return [
    models[defaultIndex],
    ...models.slice(0, defaultIndex),
    ...models.slice(defaultIndex + 1),
  ];
}

/** Resolve a stored model id to its friendly display name for inline summaries. */
export function getModelDisplayName(tool: AgenticToolName, modelId: string): string {
  if (!modelId) return modelId;
  const base = modelId.replace('[1m]', '');
  if (CLAUDE_TOOLS.has(tool)) {
    const found = AVAILABLE_CLAUDE_MODEL_ALIASES.find((m) => m.id === modelId || m.id === base);
    if (!found) return modelId;
    return modelId.includes('[1m]') ? `${found.displayName} (1M context)` : found.displayName;
  }
  const named = (metadata: Record<string, { name?: string; displayName?: string }>): string =>
    metadata[modelId]?.name ?? metadata[modelId]?.displayName ?? modelId;
  if (tool === 'codex') return named(CODEX_MODEL_METADATA as Record<string, { name: string }>);
  if (tool === 'gemini') return named(GEMINI_MODELS as Record<string, { name: string }>);
  if (tool === 'copilot') return named(COPILOT_MODEL_METADATA as Record<string, { name: string }>);
  if (tool === 'cursor')
    return named(CURSOR_MODEL_METADATA as Record<string, { displayName: string }>);
  return modelId;
}

export function ensureDefaultModelOption<T extends ModelOptionLike>(
  models: T[],
  defaultModel: string,
  makeOption: (id: string) => T
): T[] {
  if (!defaultModel || models.some((model) => model.id === defaultModel)) return models;
  return [makeOption(defaultModel), ...models];
}

export interface ModelSelectorFallbackOptions {
  /** Cursor's default can be discovered asynchronously from the daemon. */
  cursorDefaultModel?: string;
  /** Copilot's dynamic endpoint returns the daemon's effective default. */
  copilotDefaultModel?: string;
}

/**
 * Return the model the selector should render when the form has no value.
 *
 * This intentionally follows the same canonical defaults as the daemon's
 * resolveSessionDefaults/applySessionConfigDefaults path. The model list is
 * only an availability/display list; its first item may be newest/flashiest,
 * but it is not the runtime default.
 */
export function getModelSelectorFallbackModel(
  tool: AgenticToolName,
  modelList: ModelOptionLike[],
  options: ModelSelectorFallbackOptions = {}
): string {
  if (tool === 'cursor') {
    return options.cursorDefaultModel || DEFAULT_CURSOR_MODEL;
  }

  if (tool === 'copilot') {
    return options.copilotDefaultModel || getDefaultModelForTool(tool) || DEFAULT_COPILOT_MODEL;
  }

  return getDefaultModelForTool(tool) || modelList[0]?.id || '';
}
