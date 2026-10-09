import type { AgorClient, SessionID } from '@agor-live/client';
import { App } from 'antd';
import { formatActionError } from '../utils/connectionErrors';
import { useThemedMessage } from '../utils/message';
import { ARCHIVE_REFRESH_WARNING, useSessionActions } from './useSessionActions';

interface ArchiveCallbacks {
  onStart?: () => void;
  onSettled?: () => void;
  onArchived?: () => void;
}

/** The shared "archive session and same-branch children" confirmation. */
export function useConfirmArchiveSession(client: AgorClient | null) {
  const { modal } = App.useApp();
  const { showSuccess, showError, showWarning } = useThemedMessage();
  const { archiveSession } = useSessionActions(client);
  return (sessionId: string, { onStart, onSettled, onArchived }: ArchiveCallbacks = {}) => {
    modal.confirm({
      title: 'Archive this session and its subsessions?',
      content:
        'Sessions started from it on this branch are archived too. Sessions on other branches stay active.',
      okText: 'Archive',
      cancelText: 'Cancel',
      onOk: async () => {
        onStart?.();
        try {
          const result = await archiveSession(sessionId as SessionID);
          if (result.reconciliation === 'refresh-required') {
            showWarning(ARCHIVE_REFRESH_WARNING, { duration: 0 });
          } else {
            showSuccess('Session archived.');
            onArchived?.();
          }
        } catch (error) {
          showError(formatActionError('archive the session', error, { idempotent: true }));
        } finally {
          onSettled?.();
        }
      },
    });
  };
}
