import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexSandboxMode,
  PermissionMode,
} from '@agor-live/client';
import {
  getClaudeContextWindowLimit,
  getCodexContextWindowLimit,
  getCopilotContextWindowLimit,
  getDefaultPermissionMode,
  getGeminiContextWindowLimit,
  mapToCodexPermissionConfig,
} from '@agor-live/client';

/** Below this card width the row shortens the model chip and keeps at most `NARROW_PIN_LIMIT` pins. */
export const NARROW_COMPOSER_WIDTH = 480;
/** Narrow panels keep the default desktop pins (Attach, Fork, MCP tools) in the row. */
export const NARROW_PIN_LIMIT = 3;

export type ComposerCircleState = 'send' | 'stop' | 'queue';

/** The model's context window before the first turn reports one; undefined when unknown. */
export function getModelContextLimit(
  tool: AgenticToolName,
  model: string | undefined
): number | undefined {
  switch (tool) {
    case 'claude-code':
      return getClaudeContextWindowLimit(model);
    case 'codex':
      return getCodexContextWindowLimit(model);
    case 'gemini':
      return getGeminiContextWindowLimit(model);
    case 'copilot':
      return getCopilotContextWindowLimit(model);
    default:
      return undefined;
  }
}

/** The one primary button: Send, Stop with an empty box, or Queue while it runs. */
export function getComposerCircleState({
  stopAvailable,
  isRunning,
  hasInput,
}: {
  stopAvailable: boolean;
  isRunning: boolean;
  hasInput: boolean;
}): ComposerCircleState {
  if (stopAvailable && !hasInput) return 'stop';
  if (isRunning && hasInput) return 'queue';
  return 'send';
}

/** A permission chip shows only when the mode differs from the tool default. */
export function isPermissionNonDefault(
  tool: AgenticToolName,
  mode: PermissionMode,
  codex?: { sandboxMode: CodexSandboxMode; approvalPolicy: CodexApprovalPolicy }
): boolean {
  const defaultMode = getDefaultPermissionMode(tool);
  if (tool === 'codex' && codex) {
    const defaults = mapToCodexPermissionConfig(defaultMode);
    return (
      codex.sandboxMode !== defaults.sandboxMode || codex.approvalPolicy !== defaults.approvalPolicy
    );
  }
  if (tool === 'cursor') return false;
  return mode !== defaultMode;
}

/**
 * Splits pins into those shown in the row and those folded back into "+".
 * Pins follow the "+" menu order (`available`), not the order they were pinned in.
 */
export function splitPinnedActions(
  pinned: string[],
  available: string[],
  limit = Number.POSITIVE_INFINITY
): { row: string[]; folded: string[] } {
  const visible = available.filter((id) => pinned.includes(id));
  return { row: visible.slice(0, limit), folded: visible.slice(limit) };
}

export type QueueMove = 'up' | 'down' | 'front';

/** New order after moving one queued task, or null when it cannot move. */
export function moveQueuedTask<T extends string>(
  order: T[],
  taskId: T,
  move: QueueMove
): T[] | null {
  const index = order.indexOf(taskId);
  if (index < 0) return null;
  const target = move === 'front' ? 0 : move === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= order.length || target === index) return null;
  const next = order.filter((id) => id !== taskId);
  next.splice(target, 0, taskId);
  return next;
}
