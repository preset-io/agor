import type { Session } from '@agor-live/client';
import { isGatewaySession } from '@agor-live/client';

// Keep auto-sized card lists and the deferred card's fit-to-view footprint in sync.
export const BRANCH_SESSION_VIEWPORT_HEIGHT = 400;

const EMPTY_SESSIONS_SHELL_HEIGHT = 72;
const SECTION_HEADER_HEIGHT = 46;
const SESSION_ROW_HEIGHT = 42;
const SECTION_GAP_HEIGHT = 8;

export function estimateBranchSessionSectionsHeight(
  sessions: Session[],
  { sessionsExpanded = true }: { sessionsExpanded?: boolean } = {}
): number {
  const activeSessions = sessions.filter((session) => !session.archived);
  if (activeSessions.length === 0) return EMPTY_SESSIONS_SHELL_HEIGHT;

  const manualCount = activeSessions.filter(
    (session) => !session.scheduled_from_branch && !isGatewaySession(session)
  ).length;
  const scheduledCount = activeSessions.filter((session) => session.scheduled_from_branch).length;
  const gatewayCount = activeSessions.filter((session) => isGatewaySession(session)).length;

  let height = SECTION_GAP_HEIGHT;

  if (manualCount > 0) {
    height += SECTION_HEADER_HEIGHT;
    if (sessionsExpanded) {
      height += Math.min(manualCount * SESSION_ROW_HEIGHT, BRANCH_SESSION_VIEWPORT_HEIGHT);
    }
  } else {
    // The card still shows a Sessions header with the New Session action when
    // only scheduled/gateway sessions exist.
    height += SECTION_HEADER_HEIGHT;
  }
  if (scheduledCount > 0) height += SECTION_HEADER_HEIGHT;
  if (gatewayCount > 0) height += SECTION_HEADER_HEIGHT;

  return height;
}
