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

const CLAUDE_TOOLS = new Set<AgenticToolName>(['claude-code', 'claude-code-cli']);

/** Common option shape the picker renders: a friendly name plus optional blurb. */
export interface NormalizedModelOption {
  id: string;
  displayName: string;
  description?: string;
}

/** The picker's upstream lists disagree on the name field (`displayName` vs `label`). */
type LooseModelOption = {
  id: string;
  displayName?: string;
  label?: string;
  description?: string;
};

export function normalizeModelOption(model: LooseModelOption): NormalizedModelOption {
  return {
    id: model.id,
    displayName: model.displayName ?? model.label ?? model.id,
    description: model.description,
  };
}

const CLAUDE_ALIAS_PATTERN = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/;

/** Parse a Claude alias id into its model line and a comparable version number. */
function parseClaudeAlias(id: string): { line: string; version: number } | null {
  const match = CLAUDE_ALIAS_PATTERN.exec(id);
  if (!match) return null;
  const [, line, major, minor] = match;
  return { line, version: Number(major) + (minor ? Number(minor) / 100 : 0) };
}

/**
 * Curate the top-level model list: for Claude keep only the latest alias per
 * model line (Opus/Sonnet/Haiku/Fable), dropping dated snapshots, `[1m]`
 * variants, and superseded versions. The default/recommended model is surfaced
 * first. Non-Claude tools ship short curated lists already, so they pass
 * through unchanged (order preserved, default first).
 */
export function curateModelOptions(
  tool: AgenticToolName,
  models: NormalizedModelOption[],
  defaultModel: string
): NormalizedModelOption[] {
  let curated = models;

  if (CLAUDE_TOOLS.has(tool)) {
    const latestByLine = new Map<string, { option: NormalizedModelOption; version: number }>();
    for (const option of models) {
      if (option.id.includes('[1m]')) continue;
      const parsed = parseClaudeAlias(option.id);
      if (!parsed) continue;
      const existing = latestByLine.get(parsed.line);
      if (!existing || parsed.version > existing.version) {
        latestByLine.set(parsed.line, { option, version: parsed.version });
      }
    }
    const keep = new Set([...latestByLine.values()].map((entry) => entry.option.id));
    curated = models.filter((model) => keep.has(model.id));
    // Never drop the current runtime default, even if it fails to parse.
    if (defaultModel && !curated.some((model) => model.id === defaultModel)) {
      const fallback = models.find((model) => model.id === defaultModel);
      if (fallback) curated = [fallback, ...curated];
    }
  }

  const defaultIndex = curated.findIndex((model) => model.id === defaultModel);
  if (defaultIndex > 0) {
    curated = [
      curated[defaultIndex],
      ...curated.slice(0, defaultIndex),
      ...curated.slice(defaultIndex + 1),
    ];
  }
  return curated;
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
