/**
 * SessionMetadataCard - Reusable metadata card for Session objects
 *
 * Displays rich session metadata for use in popovers, modals, etc.
 * Compact, read-only design focused on quick context ("what is this session?")
 */

import type { Repo, Session, User, Worktree } from '@agor/core/types';
import { CopyOutlined, FolderOutlined } from '@ant-design/icons';
import { Button, Space, Typography, theme } from 'antd';
import type React from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { CreatedByTag } from '../metadata';
import { Tag } from '../Tag';
import { ToolIcon } from '../ToolIcon';
import { ForkPill, PILL_COLORS, RepoPill, SpawnPill, StatusPill } from './Pill';

const { Text } = Typography;

export interface SessionMetadataCardProps {
  session: Session;
  worktree?: Worktree;
  repo?: Repo;
  userById?: Map<string, User>;
  currentUserId?: string;
  compact?: boolean; // Always true for popover use case
}

export const SessionMetadataCard: React.FC<SessionMetadataCardProps> = ({
  session,
  worktree,
  repo,
  userById = new Map(),
  currentUserId,
  compact = true,
}) => {
  const { token } = theme.useToken();

  const handleCopyAgor = () => {
    copyToClipboard(session.session_id, {
      showSuccess: true,
      successMessage: 'Agor session ID copied to clipboard',
    });
  };

  const handleCopySdk = () => {
    if (session.sdk_session_id) {
      copyToClipboard(session.sdk_session_id, {
        showSuccess: true,
        successMessage: `${session.agentic_tool || 'SDK'} session ID copied to clipboard`,
      });
    }
  };

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

      {/* Agor Session ID */}
      <div
        style={{
          marginBottom: 12,
          paddingTop: 12,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: '0.85em', marginBottom: 8 }}>Agor Session ID</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            background: token.colorBgLayout,
            borderRadius: token.borderRadiusSM,
            fontFamily: token.fontFamilyCode,
            fontSize: '0.85em',
          }}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {session.session_id}
          </span>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            onClick={handleCopyAgor}
            style={{ padding: '0 4px' }}
          />
        </div>
      </div>

      {/* SDK Session ID (if available) */}
      {session.sdk_session_id && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: '0.85em', marginBottom: 8 }}>
            {session.agentic_tool || 'SDK'} Session ID
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              background: token.colorBgLayout,
              borderRadius: token.borderRadiusSM,
              fontFamily: token.fontFamilyCode,
              fontSize: '0.85em',
            }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {session.sdk_session_id}
            </span>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={handleCopySdk}
              style={{ padding: '0 4px' }}
            />
          </div>
        </div>
      )}

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

      {/* Worktree context (if available) */}
      {worktree && repo && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, fontSize: '0.85em', marginBottom: 8 }}>Worktree</div>
          <Space size={4} wrap>
            <RepoPill repoName={repo.slug} />
            <Tag icon={<FolderOutlined />} color={PILL_COLORS.worktree}>
              <span style={{ fontFamily: token.fontFamilyCode }}>{worktree.name}</span>
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
