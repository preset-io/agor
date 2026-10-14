import { useCallback } from 'react';
import { copyToClipboard } from '../../../utils/clipboard';
import { useThemedMessage } from '../../../utils/message';

/**
 * A board reload refused the save. The editor keeps the draft and offers only
 * Copy draft and Discard: a stale editor never captures a new ticket, so
 * editing again means reopening the object (a new ticket, captured at open).
 */
export const STALE_DRAFT_TITLE = "The board reloaded, so your changes weren't saved.";

/** Copy a draft the board can no longer take, with feedback. */
export function useCopyDraft() {
  const { showSuccess, showError } = useThemedMessage();
  return useCallback(
    async (text: string) => {
      if (await copyToClipboard(text)) showSuccess('Draft copied to the clipboard.');
      else showError("Couldn't copy the draft. Select the text and copy it manually.");
    },
    [showSuccess, showError]
  );
}
