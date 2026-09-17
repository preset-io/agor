import type { AgorClient } from '@agor-live/client';
import { PermissionScope } from '@agor-live/client';
import { useCallback } from 'react';
import type { AppActionsContextValue } from '../contexts/AppActionsContext';

/** Sends a tool-permission decision for a session's task; shared by the desktop and mobile shells. */
export function usePermissionDecision(
  client: AgorClient | null
): NonNullable<AppActionsContextValue['onPermissionDecision']> {
  return useCallback(
    async (sessionId, requestId, taskId, allow, scope) => {
      if (!client) return;
      try {
        await client.service(`sessions/${sessionId}/permission-decision`).create({
          requestId,
          taskId,
          allow,
          reason: allow ? 'Approved by user' : 'Denied by user',
          remember: scope !== PermissionScope.ONCE,
          scope,
        });
      } catch (error) {
        console.error('Failed to send permission decision:', error);
      }
    },
    [client]
  );
}
