import { CodeSandboxOutlined, DropboxOutlined } from '@ant-design/icons';
import { Button, Tooltip, theme } from 'antd';
import { useState } from 'react';

interface ArchiveToggleButtonProps {
  archived: boolean;
  loading?: boolean;
  onToggle: (nextArchived: boolean) => void;
  tooltip?: string;
  stopPropagation?: boolean;
}

export const ArchiveToggleButton: React.FC<ArchiveToggleButtonProps> = ({
  archived,
  loading = false,
  onToggle,
  tooltip,
  stopPropagation = true,
}) => {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);

  const title = tooltip ?? (archived ? 'Archived • Click to unarchive' : 'Click to archive');
  const icon = hovered ? (
    archived ? (
      <DropboxOutlined style={{ color: token.colorSuccess }} />
    ) : (
      <CodeSandboxOutlined style={{ color: token.colorWarning }} />
    )
  ) : archived ? (
    <CodeSandboxOutlined style={{ color: token.colorWarning }} />
  ) : (
    <DropboxOutlined style={{ color: token.colorTextSecondary }} />
  );

  return (
    <Tooltip title={title}>
      <Button
        type="text"
        size="small"
        icon={icon}
        loading={loading}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(event) => {
          if (stopPropagation) {
            event.stopPropagation();
          }
          onToggle(!archived);
        }}
      />
    </Tooltip>
  );
};
