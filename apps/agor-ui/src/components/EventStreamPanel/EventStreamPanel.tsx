/**
 * EventStreamPanel - Live WebSocket event stream panel for debugging
 *
 * Non-modal right panel that displays real-time socket events with filtering capabilities
 */

import type { AgorClient } from '@agor/core/api';
import type { Board } from '@agor/core/types';
import {
  ApiOutlined,
  CloseOutlined,
  DeleteOutlined,
  PauseOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { Badge, Button, Checkbox, Empty, Select, Space, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAppData } from '../../contexts/AppDataContext';
import type { SocketEvent } from '../../hooks/useEventStream';
import { Tag } from '../Tag';
import { EventItem, type WorktreeActions } from './EventItem';

const { Text, Title } = Typography;

export interface EventStreamPanelProps {
  collapsed: boolean;
  onToggleCollapse?: () => void;
  events: SocketEvent[];
  onClear: () => void;
  width?: number | string;
  currentUserId?: string;
  selectedSessionId?: string | null;
  worktreeActions?: WorktreeActions;
  currentBoard?: Board | null;
  client: AgorClient | null;
}

export const EventStreamPanel: React.FC<EventStreamPanelProps> = ({
  collapsed,
  onToggleCollapse,
  events,
  onClear,
  width = 700,
  currentUserId,
  selectedSessionId,
  worktreeActions,
  currentBoard,
  client,
}) => {
  const { token } = theme.useToken();

  // Get data from context
  const { worktreeById, sessionById, sessionsByWorktree, repoById, userById } = useAppData();
  const repos = useMemo(() => Array.from(repoById.values()), [repoById]);

  // Get actions from context
  const {
    onFork,
    onSubsession,
    onOpenTerminal,
    onStartEnvironment,
    onStopEnvironment,
    onViewLogs,
  } = useAppActions();

  // Merge context actions with UI-specific actions from props
  const mergedWorktreeActions: WorktreeActions = useMemo(
    () => ({
      ...worktreeActions,
      onForkSession: onFork,
      onSpawnSession: onSubsession,
      onOpenTerminal,
      onStartEnvironment,
      onStopEnvironment,
      onViewLogs,
    }),
    [
      worktreeActions,
      onFork,
      onSubsession,
      onOpenTerminal,
      onStartEnvironment,
      onStopEnvironment,
      onViewLogs,
    ]
  );
  const [includeCursor, setIncludeCursor] = useState(false);
  const [includeMessages, setIncludeMessages] = useState(false);
  const [includeTerminalData, setIncludeTerminalData] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  // Event type filters (cursor, message, tool, crud, connection, other)
  const [eventTypeFilters, setEventTypeFilters] = useState<Set<string>>(new Set());

  // CRUD operation filters (created, patched, updated, removed)
  const [crudOperationFilters, setCrudOperationFilters] = useState<Set<string>>(new Set());

  // When paused, freeze the displayed events at the moment of pause
  const [frozenEvents, setFrozenEvents] = useState<SocketEvent[]>([]);

  // Update frozen events when pausing
  const handlePauseToggle = () => {
    if (!isPaused) {
      // Pausing - freeze current events
      setFrozenEvents(events);
    }
    setIsPaused(!isPaused);
  };

  // Use frozen events when paused, live events when not paused
  const displayEvents = isPaused ? frozenEvents : events;

  // Filter events based on user preferences
  const filteredEvents = useMemo(() => {
    return displayEvents.filter((event) => {
      // Filter cursor events (checkbox)
      if (!includeCursor && event.type === 'cursor') {
        return false;
      }
      // Filter message events (checkbox)
      if (!includeMessages && event.type === 'message') {
        return false;
      }
      // Filter terminal data events (checkbox) - event name contains 'terminals'
      if (!includeTerminalData && event.eventName.includes('terminals')) {
        return false;
      }

      // Filter by event type (if any filters are active)
      if (eventTypeFilters.size > 0 && !eventTypeFilters.has(event.type)) {
        return false;
      }

      // Filter by CRUD operation (if any filters are active)
      if (crudOperationFilters.size > 0 && event.type === 'crud') {
        // Extract operation from event name (e.g., "sessions created" -> "created")
        const operation = ['created', 'patched', 'updated', 'removed'].find((op) =>
          event.eventName.includes(op)
        );
        if (!operation || !crudOperationFilters.has(operation)) {
          return false;
        }
      }

      return true;
    });
  }, [
    displayEvents,
    includeCursor,
    includeMessages,
    includeTerminalData,
    eventTypeFilters,
    crudOperationFilters,
  ]);

  const totalCount = displayEvents.length;
  const displayCount = filteredEvents.length;
  const missedCount = isPaused ? events.length - frozenEvents.length : 0;

  // When collapsed, don't render anything
  if (collapsed) {
    return null;
  }

  // Expanded state - full panel
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: token.colorBgContainer,
        borderLeft: `1px solid ${token.colorBorder}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: 12,
          borderBottom: `1px solid ${token.colorBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Space>
          <ApiOutlined />
          <Title level={5} style={{ margin: 0 }}>
            Live Event Stream
          </Title>
          <Tag color="blue" style={{ fontSize: 10, marginLeft: 4 }}>
            BETA
          </Tag>
          {currentBoard && (
            <Tag
              icon={currentBoard.icon ? <span>{currentBoard.icon}</span> : undefined}
              style={{ fontSize: 11, marginLeft: 4 }}
            >
              {currentBoard.name}
            </Tag>
          )}
        </Space>
        {onToggleCollapse && (
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            onClick={onToggleCollapse}
            danger
          />
        )}
      </div>

      <div
        style={{
          padding: '12px 12px 8px',
          borderBottom: `1px solid ${token.colorBorder}`,
          backgroundColor: token.colorBgContainer,
        }}
      >
        <Space size="small">
          <Button
            icon={isPaused ? <PlayCircleOutlined /> : <PauseOutlined />}
            onClick={handlePauseToggle}
            type={isPaused ? 'primary' : 'default'}
            size="small"
          >
            {isPaused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            icon={<DeleteOutlined />}
            onClick={onClear}
            disabled={totalCount === 0}
            type="text"
            size="small"
            danger
          >
            Clear
          </Button>
        </Space>
      </div>

      <div
        style={{
          padding: 12,
          borderBottom: `1px solid ${token.colorBorder}`,
          backgroundColor: token.colorBgContainer,
        }}
      >
        {/* Event count badge */}
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Showing
          </Text>
          <Badge
            count={displayCount}
            showZero
            style={{
              backgroundColor: token.colorPrimaryBgHover,
              color: token.colorText,
            }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            out of
          </Text>
          <Badge
            count={totalCount}
            showZero
            style={{
              backgroundColor: token.colorPrimaryBgHover,
              color: token.colorText,
            }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            events
          </Text>
          {isPaused && missedCount > 0 && (
            <>
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                •
              </Text>
              <Badge
                count={missedCount}
                style={{
                  backgroundColor: token.colorWarningBg,
                  color: token.colorWarning,
                }}
              />
              <Text type="warning" style={{ fontSize: 11 }}>
                new while paused
              </Text>
            </>
          )}
        </div>

        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          Quick Filters:
        </Text>
        <Space wrap size="middle" style={{ width: '100%' }}>
          <Checkbox checked={includeCursor} onChange={(e) => setIncludeCursor(e.target.checked)}>
            <Text style={{ fontSize: 12 }}>Cursor movement</Text>
          </Checkbox>
          <Checkbox
            checked={includeMessages}
            onChange={(e) => setIncludeMessages(e.target.checked)}
          >
            <Text style={{ fontSize: 12 }}>Message streams</Text>
          </Checkbox>
          <Checkbox
            checked={includeTerminalData}
            onChange={(e) => setIncludeTerminalData(e.target.checked)}
          >
            <Text style={{ fontSize: 12 }}>Terminal data</Text>
          </Checkbox>
        </Space>

        <Space direction="horizontal" size="small" style={{ width: '100%', marginTop: 12 }} wrap>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 200 }}>
            <Text type="secondary" style={{ marginBottom: 4, fontSize: 11 }}>
              Event Types:
            </Text>
            <Select
              mode="multiple"
              placeholder="Filter by type"
              value={Array.from(eventTypeFilters)}
              onChange={(values) => setEventTypeFilters(new Set(values))}
              style={{ width: '100%' }}
              size="small"
              allowClear
              maxTagCount="responsive"
            >
              {['cursor', 'message', 'tool', 'crud', 'connection', 'other'].map((type) => (
                <Select.Option key={type} value={type}>
                  {type}
                </Select.Option>
              ))}
            </Select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 200 }}>
            <Text type="secondary" style={{ marginBottom: 4, fontSize: 11 }}>
              CRUD Operations:
            </Text>
            <Select
              mode="multiple"
              placeholder="Filter by operation"
              value={Array.from(crudOperationFilters)}
              onChange={(values) => setCrudOperationFilters(new Set(values))}
              style={{ width: '100%' }}
              size="small"
              allowClear
              maxTagCount="responsive"
            >
              {['created', 'patched', 'updated', 'removed'].map((operation) => (
                <Select.Option key={operation} value={operation}>
                  {operation}
                </Select.Option>
              ))}
            </Select>
          </div>
        </Space>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {filteredEvents.length === 0 ? (
          <Empty
            description={
              totalCount === 0 ? 'No events captured yet' : 'No events match current filters'
            }
            style={{ marginTop: 60 }}
          />
        ) : (
          <div
            style={{
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
              overflow: 'hidden',
              margin: 12,
            }}
          >
            {filteredEvents.map((event) => (
              <EventItem
                key={event.id}
                event={event}
                worktreeById={worktreeById}
                sessionById={sessionById}
                sessionsByWorktree={sessionsByWorktree}
                repos={repos}
                userById={userById}
                currentUserId={currentUserId}
                selectedSessionId={selectedSessionId}
                worktreeActions={mergedWorktreeActions}
                client={client}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
