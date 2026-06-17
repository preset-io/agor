import { GithubOutlined, GlobalOutlined, LinkOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Dropdown, Tooltip } from 'antd';
import type React from 'react';

export interface SessionAttachmentItem {
  key: string;
  name: string;
  url: string;
}

interface Props {
  items: SessionAttachmentItem[];
}

function getIcon(url: string): React.ReactNode {
  try {
    const { hostname } = new URL(url);
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) return <GithubOutlined />;
  } catch {
    // ignore
  }
  return <GlobalOutlined />;
}

export const SessionAttachmentsDropdown: React.FC<Props> = ({ items }) => {
  if (items.length === 0) return null;

  const menuItems: MenuProps['items'] = items.map((item) => ({
    key: item.key,
    icon: getIcon(item.url),
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
    onClick: () => window.open(item.url, '_blank'),
  }));

  return (
    <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
      <Tooltip title="Attachments">
        <Badge count={items.length} size="small" offset={[-4, 4]}>
          <Button type="text" icon={<LinkOutlined />} />
        </Badge>
      </Tooltip>
    </Dropdown>
  );
};
