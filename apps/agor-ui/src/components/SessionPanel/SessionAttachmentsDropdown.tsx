import {
  FileOutlined,
  GithubOutlined,
  GlobalOutlined,
  LinkOutlined,
  ReadOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Dropdown, Tooltip, theme } from 'antd';
import type React from 'react';
import type { SessionLinkWidgetItem } from './sessionLinks';

export type SessionAttachmentItem = SessionLinkWidgetItem;

interface Props {
  items: SessionAttachmentItem[];
}

function getIcon(item: SessionAttachmentItem): React.ReactNode {
  if (item.kind === 'kb_ref' || item.refUri?.startsWith('agor://kb/')) return <ReadOutlined />;
  if (item.filePath) return <FileOutlined />;

  if (item.url) {
    try {
      const { hostname } = new URL(item.url);
      if (hostname === 'github.com' || hostname.endsWith('.github.com')) return <GithubOutlined />;
    } catch {
      // ignore
    }
  }

  return <GlobalOutlined />;
}

export const SessionAttachmentsDropdown: React.FC<Props> = ({ items }) => {
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
    disabled: !item.href,
    onClick: item.href ? () => window.open(item.href, '_blank') : undefined,
  }));

  return (
    <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
      <Tooltip title="Links">
        <Badge count={items.length} color={token.colorPrimary} size="small" offset={[-4, 4]}>
          <Button type="text" icon={<LinkOutlined style={{ color: token.colorPrimary }} />} />
        </Badge>
      </Tooltip>
    </Dropdown>
  );
};
