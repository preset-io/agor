/**
 * Shared "tone" mapping for session/task statuses.
 *
 * Returns a coarse semantic tone (`'processing' | 'warning' | 'error' |
 * 'success' | 'default'`) suitable as the `color` for AntD `<Tag>` /
 * `<Badge>`. Components that need a richer presentation (icon + label per
 * status) keep their own per-status config and can reach for this util when
 * they only need the tone.
 *
 * Accepts the union of `SessionStatus`, `TaskStatus`, and the `'pending'`
 * synonym used by `Pill.StatusPill`. Picked to match the prevailing
 * convention across `TaskStatusIcon`, `TimerPill`, and
 * `WorktreeModal/tabs/SessionsTab` — notably:
 * - `stopping` → warning (transitional, not "live")
 * - `awaiting_input` → processing (interactive, awaiting user)
 * - `awaiting_permission` → warning (passive, blocking)
 * - `queued` / `created` / `pending` / `stopped` → default
 *
 * NOTE: `TaskStatusIcon` and `Pill.StatusPill` still maintain their own
 * per-status icon+label tables. Migrating their color field to consume this
 * helper is a future cleanup — they should keep their icon/label tables
 * (richer presentation), but defer color/tone to here.
 */
import type { Session } from '@agor-live/client';

export type StatusTone = 'processing' | 'warning' | 'error' | 'success' | 'default';

/**
 * Status values this helper maps. Covers `SessionStatus`, `TaskStatus`, and
 * the `'pending'` synonym used by `Pill.StatusPill`. Accepts a wider `string`
 * type so callers don't need to narrow before passing — unknown values fall
 * through to `'default'`.
 */
export type StatusInput = Session['status'] | string;

export function getSessionStatusTone(status: StatusInput): StatusTone {
  switch (status) {
    case 'running':
    case 'awaiting_input':
      return 'processing';
    case 'stopping':
    case 'awaiting_permission':
    case 'timed_out':
      return 'warning';
    case 'failed':
      return 'error';
    case 'completed':
      return 'success';
    // idle, queued, created, pending, stopped → default
    default:
      return 'default';
  }
}
