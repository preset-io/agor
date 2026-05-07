import type { Session } from '@agor-live/client';
import { ForkOutlined, SubnodeOutlined } from '@ant-design/icons';
import { Tooltip, Typography, theme } from 'antd';
import type React from 'react';

interface SessionRelationshipIconProps {
  session: Pick<Session, 'genealogy' | 'fork_origin'>;
  /** Icon size in px (default: 11). The `btw` text label scales proportionally. */
  size?: number;
}

/**
 * Small inline icon indicating a session's relationship to its genealogy:
 * forked from a sibling, spawned from a parent, or "btw" (ephemeral fork).
 *
 * Returns null for root sessions (no parent / fork). Used in compact list
 * contexts (drawer rows, tree nodes) where the relationship grammar should
 * be consistent across the app.
 */
export const SessionRelationshipIcon: React.FC<SessionRelationshipIconProps> = ({
  session,
  size = 11,
}) => {
  const { token } = theme.useToken();
  const parentId = session.genealogy?.parent_session_id;
  const forkedFromId = session.genealogy?.forked_from_session_id;

  if (forkedFromId && session.fork_origin === 'btw') {
    return (
      <Tooltip title={`Forked (btw) from ${forkedFromId.substring(0, 8)}`}>
        <Typography.Text
          style={{
            fontSize: Math.round(size * 0.85),
            color: token.colorWarning,
            fontWeight: 'bold',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          btw
        </Typography.Text>
      </Tooltip>
    );
  }
  if (parentId) {
    return (
      <Tooltip title={`Spawned from ${parentId.substring(0, 8)}`}>
        <SubnodeOutlined style={{ fontSize: size, color: token.colorInfo, flexShrink: 0 }} />
      </Tooltip>
    );
  }
  if (forkedFromId) {
    return (
      <Tooltip title={`Forked from ${forkedFromId.substring(0, 8)}`}>
        <ForkOutlined style={{ fontSize: size, color: token.colorWarning, flexShrink: 0 }} />
      </Tooltip>
    );
  }
  return null;
};
