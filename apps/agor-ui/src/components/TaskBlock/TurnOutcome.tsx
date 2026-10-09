import { isTerminalTaskStatus } from '@agor/core/types';
import type { AgorClient, SessionID, Task } from '@agor-live/client';
import { theme } from 'antd';
import { useState } from 'react';
import { formatActionError, isInFlightConnectionLossError } from '../../utils/connectionErrors';
import { useThemedMessage } from '../../utils/message';
import { CompactNotice } from '../CompactNotice';
import type { TurnOutcomeCopy } from './describeTurnOutcome';
import type { turnOutcomeDetails } from './turnOutcomeDetails';

const RESUME_PROMPT =
  'Continue from the interrupted task. Inspect the previous task state first, then continue safely.';

interface TurnOutcomeProps {
  task: Task;
  outcome: TurnOutcomeCopy | null;
  details?: ReturnType<typeof turnOutcomeDetails>;
  isLatestTask?: boolean;
  /** A new turn may start from this outcome now: the latest settled turn, and a prompt would run, not queue. */
  canResume?: boolean;
  onOpenSettings?: () => void;
  sessionId?: SessionID | null;
  client?: AgorClient | null;
}

/** Exceptional outcomes belong after the response, never above the prompt or behind hover. */
export function TurnOutcome({
  task,
  outcome,
  details,
  isLatestTask = false,
  canResume = false,
  onOpenSettings,
  sessionId,
  client,
}: TurnOutcomeProps) {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const [submitting, setSubmitting] = useState(false);
  const [resumed, setResumed] = useState(false);
  // Announce assertively only a failure that happens while the user is watching.
  const [watchedLive] = useState(() => !isTerminalTaskStatus(task.status));
  if (!outcome) return null;

  const action =
    outcome.action === 'settings'
      ? onOpenSettings && outcome.action
      : canResume && client && sessionId && !resumed
        ? outcome.action
        : undefined;
  const handleResume = async () => {
    if (!client || !sessionId) return;
    setSubmitting(true);
    try {
      // Always a new Task; never revive the failed one or its executor.
      await client.sessions.prompt(
        sessionId,
        action === 'retry' && task.full_prompt ? task.full_prompt : RESUME_PROMPT
      );
      setResumed(true);
    } catch (error) {
      showError(
        formatActionError(action === 'retry' ? 'run it again' : 'resume', error, {
          idempotent: false,
        })
      );
      // It may have started a run: no second click until a refresh shows whether it did.
      if (isInFlightConnectionLossError(error)) setResumed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CompactNotice
      type={outcome.type}
      message={outcome.message}
      details={
        details && (outcome.type !== 'neutral' || details.hasSignal) ? details.rows : undefined
      }
      detailsLead={outcome.detailsLead}
      actions={
        action && [
          {
            label:
              action === 'settings' ? 'Open settings' : action === 'retry' ? 'Try again' : 'Resume',
            onClick: action === 'settings' ? () => onOpenSettings?.() : handleResume,
            loading: submitting,
          },
        ]
      }
      role={isLatestTask && watchedLive && outcome.type === 'error' ? 'alert' : 'status'}
      data-turn-outcome
      style={{ marginTop: token.marginSM }}
    />
  );
}
