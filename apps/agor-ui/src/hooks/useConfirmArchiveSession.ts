import type { AgorClient, SessionID } from '@agor-live/client';
import { App } from 'antd';
import { useThemedMessage } from '../utils/message';
import { ARCHIVE_REFRESH_WARNING, useSessionActions } from './useSessionActions';

interface ArchiveCallbacks {
  onStart?: () => void;
  onSettled?: () => void;
  onArchived?: () => void;
}

/** The shared "archive session and same-branch children" confirmation; several sessions share one confirm naming the count. */
export function useConfirmArchiveSession(client: AgorClient | null) {
  const { modal } = App.useApp();
  const { showSuccess, showError, showWarning } = useThemedMessage();
  const { archiveSession } = useSessionActions(client);
  return (
    target: string | readonly string[],
    { onStart, onSettled, onArchived }: ArchiveCallbacks = {}
  ) => {
    const ids = typeof target === 'string' ? [target] : [...target];
    const count = ids.length;
    const many = count > 1;
    modal.confirm({
      title: many
        ? `Archive ${count} sessions and their same-branch children?`
        : 'Archive session and same-branch children?',
      content: many
        ? `This archives all ${count} sessions and their same-branch forked or spawned descendants. Remote-created sessions stay active in their own branch.`
        : 'This archives the session and its same-branch forked or spawned descendants. Remote-created sessions stay active in their own branch.',
      okText: many ? `Archive all ${count}` : 'Archive',
      cancelText: 'Cancel',
      onOk: async () => {
        onStart?.();
        try {
          const results = [];
          // One at a time, so each cascade settles before the next starts.
          for (const id of ids) results.push(await archiveSession(id as SessionID));
          const failed = results.filter((result) => !result).length;
          if (failed === count) {
            showError(many ? 'Failed to archive sessions' : 'Failed to archive session');
          } else if (failed) {
            showError(`Failed to archive ${failed} of ${count} sessions`);
          } else if (results.some((result) => result?.reconciliation === 'refresh-required')) {
            showWarning(ARCHIVE_REFRESH_WARNING);
          } else {
            showSuccess(
              many
                ? `${count} sessions and same-branch children archived`
                : 'Session and same-branch children archived'
            );
            onArchived?.();
          }
        } finally {
          onSettled?.();
        }
      },
    });
  };
}
