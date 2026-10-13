import { useCallback, useRef } from 'react';
import { errorMessage, isInFlightConnectionLossError } from '@/utils/connectionErrors';

export type WidgetAction = 'submit' | 'dismiss';

const ALREADY_ANSWERED = /^Widget \S+ is already (submitted|dismissed); cannot \w+ again\.$/;
// The earlier attempt is still being processed, so keep it as this browser's own lost attempt.
const STILL_RESOLVING = /^Widget \S+ is already resolving; cannot \w+ again\.$/;

export const WIDGET_ALREADY_ANSWERED_MESSAGE =
  'This request was already answered. Refresh to see the result.';

/** The action the server says already resolved this widget, if it was a submit or dismiss. */
export function alreadyAnsweredBy(error: unknown): WidgetAction | null {
  const match = ALREADY_ANSWERED.exec(errorMessage(error));
  if (!match) return null;
  return match[1] === 'submitted' ? 'submit' : 'dismiss';
}

export type WidgetReplayOutcome<R> =
  | { kind: 'done'; resolution: R }
  | { kind: 'answered' }
  | { kind: 'failed' };

/** Classifies a failed submit or dismiss: `done` = this browser's lost attempt went through, `answered` = resolved elsewhere. */
export function useWidgetReplay<R>() {
  const lostAttempt = useRef<{ action: WidgetAction; resolution: R } | null>(null);
  return useCallback(
    (action: WidgetAction, resolution: R, error: unknown): WidgetReplayOutcome<R> => {
      const answeredBy = alreadyAnsweredBy(error);
      const lost = lostAttempt.current;
      if (isInFlightConnectionLossError(error)) lostAttempt.current = { action, resolution };
      else if (!STILL_RESOLVING.test(errorMessage(error))) lostAttempt.current = null;
      if (!answeredBy) return { kind: 'failed' };
      if (lost?.action === answeredBy) return { kind: 'done', resolution: lost.resolution };
      return { kind: 'answered' };
    },
    []
  );
}
