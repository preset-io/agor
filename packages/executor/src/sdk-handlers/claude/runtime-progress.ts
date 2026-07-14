import { PULSE_KIND } from '@agor/core/types';
import type { AgenticToolRuntime } from '../../runtime-overseer.js';

/** Convert Claude's noisy tool-progress event into the shared bounded pulse contract. */
export function pulseClaudeToolProgress(message: unknown, runtime?: AgenticToolRuntime): void {
  if (!runtime || !message || typeof message !== 'object') return;
  const event = message as Record<string, unknown>;
  if (event.type !== 'tool_progress') return;

  runtime.pulse({
    kind: PULSE_KIND.TOOL_PROGRESS,
    ...(typeof event.tool_use_id === 'string' ? { id: event.tool_use_id } : {}),
    ...(typeof event.tool_name === 'string' ? { label: event.tool_name } : {}),
  });
}
