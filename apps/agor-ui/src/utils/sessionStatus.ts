/**
 * Shared "tone" mapping for session/task statuses.
 *
 * Returns a coarse semantic tone (`'processing' | 'warning' | 'error' |
 * 'success' | 'default'`) suitable as the `color` for AntD `<Tag>` /
 * `<Badge>`. Components that need a richer presentation (icon + label per
 * status) keep their own per-status config and can reach for this util when
 * they only need the tone.
 *
 * Picked to match the prevailing convention across `TaskStatusIcon`,
 * `TimerPill`, and `WorktreeModal/tabs/SessionsTab` — notably:
 * - `stopping` → warning (transitional, not "live")
 * - `awaiting_input` → processing (interactive, awaiting user)
 * - `awaiting_permission` → warning (passive, blocking)
 *
 * NOTE: `TaskStatusIcon` and `Pill.StatusPill` currently maintain their own
 * per-status icon+color tables. Migrating them is out of scope for this util
 * but they should ideally collapse to consume `getSessionStatusTone` for the
 * color field.
 */
import type { Session } from '@agor-live/client';

export type StatusTone = 'processing' | 'warning' | 'error' | 'success' | 'default';

export function getSessionStatusTone(status: Session['status']): StatusTone {
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
    default:
      return 'default';
  }
}
