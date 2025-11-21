import type { Worktree } from '@agor/core/types';
import { Alert, Checkbox, Popconfirm, Typography } from 'antd';
import { type ReactNode, useState } from 'react';

interface DeleteWorktreePopconfirmProps {
  worktree: Worktree;
  sessionCount?: number;
  onConfirm: (deleteFromFilesystem: boolean) => void;
  children: ReactNode;
}

export const DeleteWorktreePopconfirm: React.FC<DeleteWorktreePopconfirmProps> = ({
  worktree,
  sessionCount = 0,
  onConfirm,
  children,
}) => {
  const [deleteFromFilesystem, setDeleteFromFilesystem] = useState(true);

  const handleConfirm = (e?: React.MouseEvent<HTMLElement>) => {
    e?.stopPropagation();
    onConfirm(deleteFromFilesystem);
  };

  const handleCancel = (e?: React.MouseEvent<HTMLElement>) => {
    e?.stopPropagation();
  };

  return (
    <Popconfirm
      title="Delete worktree?"
      overlayStyle={{ maxWidth: 500 }}
      onCancel={handleCancel}
      description={
        <div style={{ width: '100%' }}>
          <p>Are you sure you want to delete worktree "{worktree.name}"?</p>
          {sessionCount > 0 && (
            <Alert
              message={`Note: This will also delete ${sessionCount} related session(s)`}
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
            />
          )}
          <Checkbox
            checked={deleteFromFilesystem}
            onChange={e => setDeleteFromFilesystem(e.target.checked)}
            style={{ marginTop: 8 }}
          >
            Also delete worktree from filesystem
          </Checkbox>
          <div style={{ marginTop: 4, marginBottom: 0 }}>
            <Typography.Text type="secondary">Path: </Typography.Text>
            <Typography.Text code copyable style={{ fontSize: 11 }}>
              {worktree.path}
            </Typography.Text>
          </div>
        </div>
      }
      onConfirm={handleConfirm}
      okText="Delete"
      cancelText="Cancel"
      okButtonProps={{ danger: true }}
    >
      {children}
    </Popconfirm>
  );
};
