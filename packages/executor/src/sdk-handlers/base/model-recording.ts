/**
 * Honest model recording for SDK handlers.
 *
 * Single canonical home for the "what model actually ran" recording
 * conventions. Tool authors writing a new SDK handler should reach for
 * these helpers rather than inlining the logic.
 *
 * ## The contract
 *
 * Two distinct concepts that are easy to conflate:
 *
 * - **Invocation model**: what we hand the SDK so it can actually run a turn.
 *   May fall back to a tool-wide default (`DEFAULT_<TOOL>_MODEL`) when the
 *   session has no `model_config` — without *something*, we can't invoke
 *   the SDK.
 * - **Recorded / resolved model**: the audit trail — what we persist on
 *   `Task.model`, `Message.metadata.model`, and stream events as
 *   `resolvedModel`. This must be either (a) what the user explicitly
 *   selected via `session.model_config.model`, or (b) what the SDK
 *   genuinely echoed back. **Never substitute a tool default here.**
 *
 * Why this matters: when we record the default for a session that never
 * picked one, the task header, ContextWindow popover, and analytics all
 * lie about what ran. A real bug ("user picked GPT 5.5, audit said
 * GPT 5.4") cost a debug pass — the original prompt-service was already
 * invoking the right model, but the recording path silently substituted
 * `DEFAULT_CODEX_MODEL`. See the commit history on this file for the
 * fix and the test coverage.
 *
 * Practical rule for new code:
 * ```ts
 * const configuredModel = session.model_config?.model;          // for recording
 * const invocationModel = configuredModel ?? DEFAULT_X_MODEL;   // for SDK only
 * ```
 */

import type { Message } from '@agor/core/types';
import type { TokenUsage } from '../../types/token-usage.js';
import type { TasksService } from './service-clients.js';

/**
 * Resolve which model to persist on `Task.model` after a turn completes.
 *
 * Priority:
 *   1. `resultModel` — the model the tool actually invoked, sourced from
 *      `session.model_config.model` at execution time. This is the
 *      authoritative value, especially for tools whose raw SDK event omits
 *      the model name (Codex turn.completed, Gemini Finished).
 *   2. `normalizedPrimaryModel` — only populated when the raw SDK event
 *      itself echoes the model back (Claude, Copilot). Codex/Gemini
 *      normalizers intentionally leave this undefined so a stale tool-wide
 *      default cannot mask the user's selection.
 *
 * Returns undefined when neither source has a usable value, so callers can
 * skip the `Task.model` patch entirely instead of writing an empty string.
 *
 * Object-arg signature: the two inputs are the same type and the priority
 * is the point of the function, so named args avoid order-of-argument
 * confusion at the call site.
 */
export function resolveTaskModelFromResult(args: {
  resultModel?: string;
  normalizedPrimaryModel?: string;
}): string | undefined {
  return args.resultModel || args.normalizedPrimaryModel || undefined;
}

/**
 * Build the `metadata` block for an assistant message in a tool-agnostic
 * way. Conditional spreads keep optional fields absent from the persisted
 * JSON when their value is unknown — instead of writing `{ model: undefined,
 * ... }` which is a different shape than `{ ... }` for some consumers.
 *
 * Tool authors: do NOT inline `{ model: resolvedModel || DEFAULT_X_MODEL }`
 * here. Pass `model` through honestly — the display layer renders nothing
 * when undefined, which is the correct UX.
 */
export function buildAssistantMessageMetadata(args: {
  model?: string;
  tokenUsage?: TokenUsage;
}): NonNullable<Message['metadata']> {
  return {
    ...(args.model ? { model: args.model } : {}),
    tokens: {
      input: args.tokenUsage?.input_tokens ?? 0,
      output: args.tokenUsage?.output_tokens ?? 0,
    },
  };
}

/**
 * Patch `Task.model` from a tool's per-message create flow.
 *
 * No-op when the model is genuinely unknown (legacy session, SDK didn't
 * echo) — leave `Task.model` unset until base-executor's post-turn patch
 * fills it in (or also leaves it unset if still unknown). This is the
 * single canonical writer for the "live UI sees the model pill before
 * the turn completes" UX feature; before consolidation it was duplicated
 * across four `createAssistantMessage` helpers.
 *
 * Idempotent — base-executor's post-turn patch may write the same value
 * again. That's fine; both writers agree on the source of truth.
 */
export async function patchTaskModelIfKnown(
  tasksService: TasksService | undefined,
  taskId: string | undefined,
  model: string | undefined
): Promise<void> {
  if (!tasksService || !taskId || !model) return;
  await tasksService.patch(taskId, { model });
}
