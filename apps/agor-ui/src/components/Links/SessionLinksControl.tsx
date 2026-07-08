import type { Branch, Link } from '@agor-live/client';
import { LinkOutlined } from '@ant-design/icons';
import { Badge, Button, Popover, Tooltip, theme } from 'antd';
import type React from 'react';
import { useMemo } from 'react';
import { LinkDisplayList } from './LinkDisplayList';
import { buildLinkDisplayItems, type LinkDisplayItem } from './linkDisplay';

interface SessionLinksControlProps {
  branch?: Pick<Branch, 'issue_url' | 'pull_request_url'> | null;
  links: readonly Link[];
  disabled?: boolean;
  pinningLinkId?: string | null;
  onTogglePinned?: (item: LinkDisplayItem) => void;
}

export const SessionLinksControl: React.FC<SessionLinksControlProps> = ({
  branch,
  links,
  disabled = false,
  pinningLinkId = null,
  onTogglePinned,
}) => {
  const { token } = theme.useToken();
  const items = useMemo(() => buildLinkDisplayItems({ branch, links }), [branch, links]);

  if (items.length === 0) return null;

  const content = (
    <div style={{ width: 420, maxWidth: '70vw' }} onClick={(event) => event.stopPropagation()}>
      <LinkDisplayList
        items={items}
        compact
        showPinActions
        pinActionDisabled={disabled}
        pinningLinkId={pinningLinkId}
        onTogglePinned={onTogglePinned}
      />
    </div>
  );

  return (
    <Popover content={content} title="Session links" trigger="click" placement="bottomRight">
      <Tooltip title="Session links">
        <Badge count={items.length} color={token.colorPrimary} size="small" offset={[-4, 4]}>
          <Button type="text" icon={<LinkOutlined style={{ color: token.colorPrimary }} />} />
        </Badge>
      </Tooltip>
    </Popover>
  );
};

export default SessionLinksControl;
