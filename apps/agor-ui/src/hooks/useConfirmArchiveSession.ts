import type { AgorClient, SessionID } from '@agor-live/client';
import { App } from 'antd';
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
      title: 'Archive session and same-branch children?',
      content:
        'This archives the session and its same-branch forked or spawned descendants. Remote-created sessions stay active in their own branch.',
      okText: 'Archive',
      cancelText: 'Cancel',
      onOk: async () => {
        onStart?.();
        try {
          const result = await archiveSession(sessionId as SessionID);
          if (result?.reconciliation === 'refresh-required') {
            showWarning(ARCHIVE_REFRESH_WARNING);
          } else if (result) {
            showSuccess('Session and same-branch children archived');
            onArchived?.();
          } else {
            showError('Failed to archive session');
          }
        } finally {
          onSettled?.();
        }
      },
    });
  };
}
