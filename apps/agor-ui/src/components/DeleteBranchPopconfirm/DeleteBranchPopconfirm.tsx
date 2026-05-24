import type { Branch } from '@agor-live/client';
import { Alert, Checkbox, Popconfirm, Typography } from 'antd';
import { type ReactNode, useState } from 'react';

interface DeleteBranchPopconfirmProps {
  branch: Branch;
  sessionCount?: number;
  onConfirm: (deleteFromFilesystem: boolean) => void;
  children: ReactNode;
}

export const DeleteBranchPopconfirm: React.FC<DeleteBranchPopconfirmProps> = ({
  branch,
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
      title="Delete branch?"
      overlayStyle={{ maxWidth: 500 }}
      onCancel={handleCancel}
      description={
        <div style={{ width: '100%' }}>
          <p>Are you sure you want to delete branch "{branch.name}"?</p>
          {sessionCount > 0 && (
            <Alert
              title={`Note: This will also delete ${sessionCount} related session(s)`}
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
            />
          )}
          <Checkbox
            checked={deleteFromFilesystem}
            onChange={(e) => setDeleteFromFilesystem(e.target.checked)}
            style={{ marginTop: 8 }}
          >
            Also delete branch from filesystem
          </Checkbox>
          <div style={{ marginTop: 4, marginBottom: 0 }}>
            <Typography.Text type="secondary">Path: </Typography.Text>
            <Typography.Text code copyable style={{ fontSize: 11 }}>
              {branch.path}
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
