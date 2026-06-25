import { GithubOutlined, GlobalOutlined, LinkOutlined, ReadOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Dropdown, Tooltip, theme } from 'antd';
import type React from 'react';

export interface SessionAttachmentItem {
  key: string;
  name: string;
  url: string;
  kind?: 'github' | 'knowledge' | 'other';
}

interface Props {
  items: SessionAttachmentItem[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function getIcon(item: SessionAttachmentItem): React.ReactNode {
  if (item.kind === 'knowledge') return <ReadOutlined />;
  try {
    const { hostname } = new URL(item.url);
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) return <GithubOutlined />;
  } catch {
    // ignore
  }
  return <GlobalOutlined />;
}

export const SessionAttachmentsDropdown: React.FC<Props> = ({ items, open, onOpenChange }) => {
  const { token } = theme.useToken();

  if (items.length === 0) return null;

  const menuItems: MenuProps['items'] = items.map((item) => ({
    key: item.key,
    icon: getIcon(item),
    label: (
      <Tooltip title={item.name.length > 40 ? item.name : undefined} placement="left">
        <span
          style={{
            display: 'inline-block',
            maxWidth: 200,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.name}
        </span>
      </Tooltip>
    ),
    onClick: () => {
      try {
        const { protocol } = new URL(item.url);
        if (protocol === 'http:' || protocol === 'https:') {
          window.open(item.url, '_blank', 'noopener,noreferrer');
        }
      } catch {
        // invalid URL — do nothing
      }
    },
  }));

  return (
    <Dropdown
      menu={{ items: menuItems }}
      trigger={['click']}
      placement="bottomRight"
      open={open}
      onOpenChange={onOpenChange}
    >
      <Tooltip title="Attachments">
        <Badge count={items.length} color={token.colorPrimary} size="small" offset={[-4, 4]}>
          <Button type="text" icon={<LinkOutlined style={{ color: token.colorPrimary }} />} />
        </Badge>
      </Tooltip>
    </Dropdown>
  );
};
