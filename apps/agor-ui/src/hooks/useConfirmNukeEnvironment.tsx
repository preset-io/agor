import { FireOutlined } from '@ant-design/icons';
import { theme } from 'antd';
import { useThemedModal } from '../utils/modal';

/**
 * Single source of truth for the "nuke environment" confirmation dialog.
 * Callers (EnvironmentPill, WorktreeHeaderPill, EnvironmentTab) must use
 * this so the destructive copy and button styling stay consistent.
 */
export function useConfirmNukeEnvironment() {
  const { confirm } = useThemedModal();
  const { token } = theme.useToken();

  return (onConfirm: () => void | Promise<void>) =>
    confirm({
      title: 'Nuke environment?',
      icon: <FireOutlined style={{ color: token.colorError }} />,
      content: (
        <>
          <p>
            <strong>This is a destructive operation.</strong>
          </p>
          <p>
            This typically removes all Docker volumes, databases, and other environment state.
            Source files in the worktree are not deleted, but anything stored inside containers or
            volumes may be lost.
          </p>
        </>
      ),
      okText: 'Nuke environment',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: onConfirm,
    });
}
