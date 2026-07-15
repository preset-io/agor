/**
 * SessionMetadataCard - Reusable metadata card for Session objects
 *
 * Displays rich session metadata for use in popovers, modals, etc.
 * Compact, read-only design focused on quick context ("what is this session?")
 */

import type { Branch, Repo, Session, User } from '@agor-live/client';
import { FolderOutlined } from '@ant-design/icons';
import { Space, Typography, theme } from 'antd';
import type React from 'react';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { CreatedByTag } from '../metadata';
import { SessionIdsList } from '../SessionIds';
import { Tag } from '../Tag';
import { ToolIcon } from '../ToolIcon';
import { ForkPill, PILL_COLORS, RepoPill, SpawnPill, StatusPill } from './Pill';

const { Text } = Typography;

export interface SessionMetadataCardProps {
  session: Session;
  branch?: Branch;
  repo?: Repo;
  userById?: Map<string, User>;
  currentUserId?: string;
  compact?: boolean; // Always true for popover use case
}

export const SessionMetadataCard: React.FC<SessionMetadataCardProps> = ({
  session,
  branch,
  repo,
  userById = new Map(),
  currentUserId,
  compact = true,
}) => {
  const { token } = theme.useToken();

  return (
    <div style={{ width: 400, maxWidth: '90vw' }}>
      {/* Primary info: Agent icon + Title + Status */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <ToolIcon tool={session.agentic_tool} size={24} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text
              strong
              style={{
                fontSize: '1.05em',
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {getSessionDisplayTitle(session, { fallbackChars: 60, includeAgentFallback: true })}
            </Text>
          </div>
        </div>

        <div style={{ marginBottom: 8 }}>
          <Space size={4}>
            <Text type="secondary" style={{ fontSize: '0.85em' }}>
              Status:
            </Text>
            <StatusPill status={session.status} />
          </Space>
        </div>
      </div>

      {/* Session IDs — shared with SessionIdsButton popover and Settings modal.
          For Claude Code CLI sessions the two are the same UUID by design
          (we pass --session-id <agor> to the binary); for SDK adapters they
          typically differ. SDK row is hidden when no sdk_session_id has
          been captured yet (fresh SDK sessions before the first response). */}
      <div style={{ marginBottom: 12 }}>
        <SessionIdsList session={session} />
      </div>

      {/* Genealogy (if applicable) */}
      {(session.genealogy.forked_from_session_id || session.genealogy.parent_session_id) && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: '0.85em', marginBottom: 8 }}>Genealogy</div>
          <Space size={4}>
            {session.genealogy.forked_from_session_id && (
              <ForkPill fromSessionId={session.genealogy.forked_from_session_id} />
            )}
            {session.genealogy.parent_session_id && (
              <SpawnPill fromSessionId={session.genealogy.parent_session_id} />
            )}
          </Space>
        </div>
      )}

      {/* Branch context (if available) */}
      {branch && repo && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: '0.85em', marginBottom: 8 }}>Branch</div>
          <Space size={4} wrap>
            <RepoPill repoName={repo.slug} />
            <Tag icon={<FolderOutlined />} color={PILL_COLORS.branch}>
              <span style={{ fontFamily: token.fontFamilyCode }}>{branch.name}</span>
            </Tag>
          </Space>
        </div>
      )}

      {/* Metadata */}
      <div
        style={{
          fontSize: '0.85em',
          color: token.colorTextSecondary,
          paddingTop: 12,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {session.created_by && (
          <div style={{ marginBottom: 4 }}>
            <CreatedByTag
              createdBy={session.created_by}
              currentUserId={currentUserId}
              userById={userById}
              prefix="Created by"
            />
          </div>
        )}
        <div style={{ marginBottom: 4 }}>
          <Text type="secondary">Created: </Text>
          {new Date(session.created_at).toLocaleString()}
        </div>
        <div style={{ marginBottom: 4 }}>
          <Text type="secondary">Agent: </Text>
          {session.agentic_tool}
        </div>
        {session.permission_config?.mode && (
          <div>
            <Text type="secondary">Permission mode: </Text>
            {session.permission_config.mode}
          </div>
        )}
      </div>
    </div>
  );
};
