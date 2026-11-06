import { type Session, SessionStatus, sessionCanStartTask } from '@agor-live/client';

/**
 * A prompt sent now would start the next turn instead of waiting in the queue:
 * the queue drainer's `sessionCanStartTask`, plus a failed session whose unread
 * flag was cleared on open, which the prompt route repairs before admitting the
 * prompt. Nothing repairs a timed-out session once that flag is cleared.
 */
export function canSessionStartTurn(
  session: Pick<Session, 'status' | 'ready_for_prompt'> &
    Partial<Pick<Session, 'archived' | 'archived_reason'>>,
  queuedTaskCount: number
): boolean {
  if (queuedTaskCount > 0) return false;
  // Imported history is read-only; the server refuses prompts to it.
  if (session.archived && session.archived_reason === 'imported') return false;
  return (
    sessionCanStartTask(session.status, session.ready_for_prompt) ||
    session.status === SessionStatus.FAILED
  );
}
