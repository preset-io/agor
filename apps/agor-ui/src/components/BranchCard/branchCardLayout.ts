import type { Session } from '@agor-live/client';
import { isGatewaySession } from '@agor-live/client';

const EMPTY_SESSIONS_SHELL_HEIGHT = 72;
const SECTION_HEADER_HEIGHT = 46;
const SESSION_ROW_HEIGHT = 42;
const SECTION_GAP_HEIGHT = 8;

export function estimateBranchSessionSectionsHeight(
  sessions: Session[],
  { defaultExpanded = true }: { defaultExpanded?: boolean } = {}
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
    if (defaultExpanded) height += manualCount * SESSION_ROW_HEIGHT;
  } else {
    // The card still shows a Sessions header with the New Session action when
    // only scheduled/gateway sessions exist.
    height += SECTION_HEADER_HEIGHT;
  }
  if (scheduledCount > 0) height += SECTION_HEADER_HEIGHT;
  if (gatewayCount > 0) height += SECTION_HEADER_HEIGHT;

  return height;
}
