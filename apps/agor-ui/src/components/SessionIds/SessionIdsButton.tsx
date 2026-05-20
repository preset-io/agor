import { IdcardOutlined } from '@ant-design/icons';
import { Button, Popover, Tooltip } from 'antd';
import type React from 'react';
import { type SessionForIds, SessionIdsList } from './SessionIdsList';

interface SessionIdsButtonProps {
  session: SessionForIds;
}

/**
 * Compact icon-button trigger for the Session IDs popover. Replaces the
 * wider SessionIdPill in dense footer contexts; click-to-open (instead of
 * hover) avoids stray fires during normal footer mousing.
 */
export const SessionIdsButton: React.FC<SessionIdsButtonProps> = ({ session }) => (
  <Popover
    title={
      <span>
        <IdcardOutlined style={{ marginRight: 8 }} />
        Session IDs
      </span>
    }
    content={
      <div style={{ width: 400, maxWidth: '90vw' }}>
        <SessionIdsList session={session} />
      </div>
    }
    trigger="click"
    placement="topLeft"
  >
    <Tooltip title="Session IDs">
      <Button type="text" size="small" icon={<IdcardOutlined />} aria-label="Session IDs" />
    </Tooltip>
  </Popover>
);
