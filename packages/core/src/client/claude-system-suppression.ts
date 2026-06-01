/**
 * Shared suppression rules for noisy Claude Agent SDK `type:'system'` events.
 *
 * Blacklist philosophy: surface unknown subtypes by default so newly added
 * SDK events (e.g. `mirror_error`, `notification`, `api_retry`, `memory_recall`,
 * `plugin_install`) reach users without code changes. Only entries we have
 * confirmed are pure lifecycle telemetry belong in the suppress set.
 *
 * Two consumers:
 *   - executor (`message-processor.ts`): drops these before they ever become
 *     persisted sdk_event blocks. Forward-only.
 *   - UI (`RateLimitBlock`): defensive filter for sdk_event rows already in the
 *     DB from sessions created before a given suppression entry was added.
 *
 * History:
 *   - PR #1116 added `status='requesting'`.
 *   - PR #1172 added `task_updated` and lifted both rules into this shared
 *     module so the executor + UI no longer hardcode the same literals.
 *
 * This module is browser-safe: it imports types only from
 * `@anthropic-ai/claude-agent-sdk` (erased at runtime).
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The exhaustive set of `subtype` values for SDK messages with `type:'system'`,
 * pulled from the SDK's discriminated union. A rename in the SDK turns into a
 * type error at the call site, rather than a silent miss.
 */
export type ClaudeSystemSubtype = Extract<SDKMessage, { type: 'system' }>['subtype'];

/**
 * The `status` values an `SDKStatusMessage` can carry, again derived from the
 * SDK union so an upstream rename trips typecheck instead of silently leaking.
 */
export type ClaudeSystemStatus = Extract<
  SDKMessage,
  { type: 'system'; subtype: 'status' }
>['status'];

/**
 * System subtypes we suppress on sight — pure lifecycle telemetry that has no
 * user-meaningful content on its own.
 *
 * Task failure visibility note: `task_*` events are suppressed wholesale,
 * including `task_updated` rows where `patch.error` is set. The Task tool's
 * own `tool_result` block (with `is_error: true`) is the authoritative surface
 * for subagent task failures; the parallel `task_*` telemetry stream is
 * redundant. If that invariant ever breaks, revisit this set.
 */
export const SUPPRESSED_CLAUDE_SYSTEM_SUBTYPES: ReadonlySet<ClaudeSystemSubtype> = new Set([
  'files_persisted',
  'session_state_changed',
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
] as const);

/**
 * `SDKStatusMessage.status` values we suppress. `requesting` fires on every
 * API call; `compacting` is handled separately in the executor (it renders as
 * a real SYSTEM "Compacting…" message). Other status values — `null` (the SDK's
 * "no active status" sentinel, often co-occurring with `permissionMode` or
 * `compact_result` fields) and any future additions — are intentionally allowed
 * to fall through to the generic sdk_event surfacer.
 */
export const SUPPRESSED_CLAUDE_STATUSES: ReadonlySet<NonNullable<ClaudeSystemStatus>> = new Set([
  'requesting',
] as const);

/**
 * Block shape persisted on `sdk_event` content blocks. Loose by design: this
 * helper is consumed by the UI from message rows that may predate any given
 * schema revision.
 */
interface PersistedSdkEventBlock {
  type?: string;
  sdkType?: string;
  sdkSubtype?: string;
  metadata?: unknown;
}

/**
 * Defensive UI filter: returns true when an already-persisted `sdk_event`
 * block matches one of our suppression rules and should be hidden from the
 * transcript. Catches rows written before the executor learned to drop them.
 */
export function shouldHidePersistedClaudeSdkEvent(block: PersistedSdkEventBlock): boolean {
  if (block.type !== 'sdk_event') return false;
  if (block.sdkType !== 'system') return false;
  if (!block.sdkSubtype) return false;

  if ((SUPPRESSED_CLAUDE_SYSTEM_SUBTYPES as ReadonlySet<string>).has(block.sdkSubtype)) {
    return true;
  }

  if (block.sdkSubtype === 'status') {
    const status =
      typeof block.metadata === 'object' && block.metadata !== null
        ? (block.metadata as { status?: unknown }).status
        : undefined;
    if (
      typeof status === 'string' &&
      (SUPPRESSED_CLAUDE_STATUSES as ReadonlySet<string>).has(status)
    ) {
      return true;
    }
  }

  return false;
}
