import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexSandboxMode,
  PermissionMode,
} from '@agor-live/client';
import { getDefaultPermissionMode, mapToCodexPermissionConfig } from '@agor-live/client';

/** Below this card width the row keeps the phone rule: 2 pins and a short model chip. */
export const NARROW_COMPOSER_WIDTH = 480;

export type ComposerCircleState = 'send' | 'stop' | 'queue';

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

/** Splits pins into those shown in the row and those folded back into "+". */
export function splitPinnedActions(
  pinned: string[],
  available: string[],
  limit = Number.POSITIVE_INFINITY
): { row: string[]; folded: string[] } {
  const visible = pinned.filter((id) => available.includes(id));
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
