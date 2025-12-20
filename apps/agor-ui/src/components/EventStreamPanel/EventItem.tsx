/**
 * EventItem - Display a single socket event with timestamp, type, and data
 */

import type { AgorClient } from '@agor/core/api';
import type { Repo, Session, SpawnConfig, User, Worktree } from '@agor/core/types';
import {
  AimOutlined,
  ApiOutlined,
  CodeOutlined,
  FolderOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Button, Popover, Typography, theme } from 'antd';
import React from 'react';
import type { SocketEvent } from '../../hooks/useEventStream';
import { UserAvatar } from '../metadata/UserAvatar';
import { EventStreamPill, SessionMetadataCard } from '../Pill';
import { Tag } from '../Tag';
import WorktreeCard from '../WorktreeCard/WorktreeCard';

const { Text } = Typography;

export interface WorktreeActions {
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (worktreeId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onOpenTerminal?: (commands: string[], worktreeId?: string) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onOpenSettings?: (worktreeId: string) => void;
  onViewLogs?: (worktreeId: string) => void;
  onNukeEnvironment?: (worktreeId: string) => void;
}

export interface EventItemProps {
  event: SocketEvent;
  worktreeById: Map<string, Worktree>;
  sessionById: Map<string, Session>;
  sessionsByWorktree: Map<string, Session[]>;
  repos: Repo[];
  userById: Map<string, User>;
  currentUserId?: string;
  selectedSessionId?: string | null;
  worktreeActions?: WorktreeActions;
  client: AgorClient | null;
}

const EventItemComponent = ({
  event,
  worktreeById,
  sessionById,
  sessionsByWorktree,
  repos,
  userById,
  currentUserId,
  selectedSessionId,
  worktreeActions,
  client,
}: EventItemProps): React.JSX.Element => {
  const { token } = theme.useToken();

  // Get icon based on event type
  const getIcon = () => {
    switch (event.type) {
      case 'cursor':
        return <AimOutlined style={{ color: token.colorInfo }} />;
      case 'message':
        return <MessageOutlined style={{ color: token.colorSuccess }} />;
      case 'tool':
        return <ToolOutlined style={{ color: token.colorPrimary }} />;
      case 'crud':
        return <ThunderboltOutlined style={{ color: token.colorWarning }} />;
      case 'connection':
        return <ApiOutlined style={{ color: token.colorError }} />;
      default:
        return <ToolOutlined style={{ color: token.colorTextSecondary }} />;
    }
  };

  // Get color based on event type
  const getTagColor = () => {
    switch (event.type) {
      case 'cursor':
        return 'blue';
      case 'message':
        return 'green';
      case 'tool':
        return 'purple';
      case 'crud':
        return 'orange';
      case 'connection':
        return 'red';
      default:
        return 'default';
    }
  };

  // Format timestamp
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  };

  // Serialize data for display
  const formatData = (data: unknown): string => {
    if (data === null || data === undefined) {
      return '';
    }
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  // Split event name into entity and action
  const parseEventName = (eventName: string): { entity?: string; action?: string } => {
    const actions = ['created', 'patched', 'updated', 'removed'];
    const foundAction = actions.find((action) => eventName.includes(action));

    if (foundAction) {
      // Extract entity by removing the action
      const entity = eventName.replace(foundAction, '').trim();
      return { entity, action: foundAction };
    }

    // If no action found, return the full event name as entity
    return { entity: eventName };
  };

  // Extract session_id, worktree_id, and created_by from event data
  const sessionId =
    event.data && typeof event.data === 'object' && 'session_id' in event.data
      ? (event.data.session_id as string)
      : undefined;

  const worktreeId =
    event.data && typeof event.data === 'object' && 'worktree_id' in event.data
      ? (event.data.worktree_id as string)
      : undefined;

  const createdBy =
    event.data && typeof event.data === 'object' && 'created_by' in event.data
      ? (event.data.created_by as string)
      : undefined;

  // Lookup full objects from maps
  const session = sessionId ? sessionById.get(sessionId) : undefined;
  // Derive worktree from session if not directly in event data
  const derivedWorktreeId = worktreeId || session?.worktree_id;
  const worktree = derivedWorktreeId ? worktreeById.get(derivedWorktreeId) : undefined;
  const repo = worktree ? repos.find((r) => r.repo_id === worktree.repo_id) : undefined;
  const worktreeSessions = worktree ? sessionsByWorktree.get(worktree.worktree_id) || [] : [];

  // Look up user if created_by is present
  const user = createdBy ? userById.get(createdBy) : undefined;

  // Parse event name into entity and action
  const { entity, action } = parseEventName(event.eventName);

  // JSON details popover content
  const detailsContent: React.JSX.Element = event.data ? (
    <div style={{ maxWidth: 400, maxHeight: 400, overflow: 'auto' }}>
      <pre
        style={{
          margin: 0,
          padding: 12,
          background: token.colorBgLayout,
          borderRadius: token.borderRadiusSM,
          fontSize: 11,
          wordBreak: 'break-all',
          whiteSpace: 'pre-wrap',
        }}
      >
        {formatData(event.data)}
      </pre>
    </div>
  ) : (
    <Text type="secondary">No data</Text>
  );

  return (
    <div
      style={{
        padding: '6px 12px',
        borderLeft: `3px solid ${token.colorPrimary}`,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
      }}
    >
      {getIcon()}

      <Text code style={{ fontSize: 11, color: token.colorTextSecondary, minWidth: 85 }}>
        {formatTime(event.timestamp)}
      </Text>

      <Tag
        color={getTagColor()}
        style={{ margin: 0, fontSize: 11, minWidth: 70, textAlign: 'center' }}
      >
        {event.type}
      </Tag>

      {/* Entity tag (e.g., "sessions", "worktrees") */}
      {entity && (
        <Tag
          style={{
            margin: 0,
            fontSize: 11,
            backgroundColor: token.colorBgContainer,
            borderColor: token.colorBorder,
            color: token.colorText,
          }}
        >
          {entity}
        </Tag>
      )}

      {/* Action tag (e.g., "created", "patched") */}
      {action && (
        <Tag
          color={
            action === 'created'
              ? 'green'
              : action === 'removed'
                ? 'red'
                : action === 'patched' || action === 'updated'
                  ? 'orange'
                  : 'default'
          }
          style={{ margin: 0, fontSize: 11 }}
        >
          {action}
        </Tag>
      )}

      {/* Fallback: if no entity/action split, show full event name */}
      {!entity && !action && (
        <Text
          strong
          style={{
            fontSize: 12,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {event.eventName}
        </Text>
      )}

      <div style={{ flex: 1 }} />

      {/* Session ID pill */}
      {sessionId && (
        <EventStreamPill
          id={sessionId}
          icon={CodeOutlined}
          color="cyan"
          copyLabel="Session ID"
          metadataCard={
            session ? (
              <SessionMetadataCard
                session={session}
                worktree={worktree}
                repo={repo}
                userById={userById}
                currentUserId={currentUserId}
                compact
              />
            ) : undefined
          }
        />
      )}

      {/* Worktree ID pill */}
      {derivedWorktreeId && worktree && repo && (
        <EventStreamPill
          id={derivedWorktreeId}
          label={worktree.name}
          icon={FolderOutlined}
          color="geekblue"
          copyLabel="Worktree ID"
          metadataCard={
            <WorktreeCard
              worktree={worktree}
              repo={repo}
              sessions={worktreeSessions}
              userById={userById}
              currentUserId={currentUserId}
              selectedSessionId={selectedSessionId}
              inPopover={true}
              client={client}
              {...worktreeActions}
            />
          }
        />
      )}

      {/* User pill - shows who triggered this event */}
      {user && (
        <Tag icon={<UserOutlined />} color="magenta" style={{ margin: 0, fontSize: 11 }}>
          <UserAvatar user={user} showName={true} size="small" />
        </Tag>
      )}

      {event.data ? (
        <Popover content={detailsContent} title="Event Data" trigger="click" placement="left">
          <Button
            type="text"
            size="small"
            icon={<InfoCircleOutlined />}
            style={{ padding: '0 4px' }}
          />
        </Popover>
      ) : null}
    </div>
  );
};

// Memoize to prevent re-rendering existing items when new events arrive
// Only re-render if the event itself or any of the lookup maps change
export const EventItem = React.memo(EventItemComponent);
