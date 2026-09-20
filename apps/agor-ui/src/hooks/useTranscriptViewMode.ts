import type { AgorClient, TranscriptViewMode } from '@agor-live/client';
import { resolveTranscriptViewMode } from '@agor-live/client';
import { useCallback } from 'react';
import { useAgorStore } from '../store/agorStore';
import { selectUserById } from '../store/selectors';
import { useThemedMessage } from '../utils/message';

export interface TranscriptViewModeControl {
  mode: TranscriptViewMode;
  /** False while the current user record is unavailable, so the control hides. */
  canChange: boolean;
  setMode: (next: TranscriptViewMode) => void;
}

/**
 * The signed-in user's transcript view, shared by every session they open on
 * every device. The choice lives in `user.preferences`; until they make one,
 * `resolveTranscriptViewMode` decides from the account's age.
 */
export function useTranscriptViewMode(
  client: AgorClient | null,
  currentUserId: string | undefined
): TranscriptViewModeControl {
  const { showError } = useThemedMessage();
  const userById = useAgorStore(selectUserById);
  const currentUser = currentUserId ? userById.get(currentUserId) : undefined;
  const mode = resolveTranscriptViewMode(currentUser);

  const setMode = useCallback(
    async (next: TranscriptViewMode) => {
      if (!client || !currentUser) return;
      try {
        await client.service('users').patch(currentUser.user_id, {
          preferences: { ...currentUser.preferences, transcriptViewMode: next },
        });
      } catch (error) {
        showError(
          `Failed to save transcript view: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    [client, currentUser, showError]
  );

  return { mode, canChange: !!client && !!currentUser, setMode };
}
