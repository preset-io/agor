import type { SDKMessage } from '@agor/core/sdk';
import { getSdkActivityVersion } from '../../sdk-watchdog.js';

/**
 * Whose conversation a message belongs to.
 *
 * `unknown` is not a formality. `parent_tool_use_id` crosses a stdout/JSON
 * boundary, so the `.d.ts` declaring it `string | null` constrains what the
 * compiler accepts, not what arrives on the wire — an omitted key deserializes
 * to `undefined` whatever the type says. Every other reader in this repo
 * already coerces it (`message-processor.ts`, `claude-tool.ts`, the daemon's
 * message validator), and the SDK is pinned by caret range, so a shape this
 * code has never seen is a routine dependency bump away.
 *
 * Both readers therefore treat `unknown` as "not proven", and both land on the
 * side that keeps work alive and bounded rather than the side that truncates
 * it: an unclassifiable message never marks a task as nested (so the task
 * stays tracked and the query stays open for it), and never counts as the
 * top-level turn resuming (so the turn stays inside its silence budget).
 */
export type TurnScope = 'top-level' | 'subagent' | 'unknown';

let warnedUnknownScope = false;

export function classifyTurnScope(message: SDKMessage): TurnScope {
  const parent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  if (parent === null) return 'top-level';
  if (typeof parent === 'string' && parent.length > 0) return 'subagent';
  // Once per process: this means the SDK contract moved, and every later
  // decision made from it is a guess.
  if (!warnedUnknownScope) {
    warnedUnknownScope = true;
    console.warn(
      `⚠️  SDK message ${message.type} carries an unusable parent_tool_use_id ` +
        `(${parent === undefined ? 'absent' : typeof parent}); background-task scoping ` +
        `falls back to "keep tracking, stay bounded" [sdk=${getSdkActivityVersion('claude-code')}]`
    );
  }
  return 'unknown';
}

/** Test seam: the unknown-shape warning is deliberately once per process. */
export function resetTurnScopeWarningForTests(): void {
  warnedUnknownScope = false;
}
