import type { AgenticToolName } from '@agor-live/client';
import {
  DEFAULT_COPILOT_MODEL,
  DEFAULT_CURSOR_MODEL,
  getDefaultModelForTool,
} from '@agor-live/client';

export { DEFAULT_CURSOR_MODEL };

export interface ModelOptionLike {
  id: string;
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
