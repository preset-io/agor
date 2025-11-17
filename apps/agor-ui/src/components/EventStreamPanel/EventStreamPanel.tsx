/**
 * EventStreamPanel - Live WebSocket event stream panel for debugging
 *
 * Non-modal right panel that displays real-time socket events with filtering capabilities
 */

import {
  ApiOutlined,
  CloseOutlined,
  DeleteOutlined,
  PauseOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { Badge, Button, Checkbox, Empty, Space, Tag, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import type { SocketEvent } from '../../hooks/useEventStream';
import { EventItem } from './EventItem';

const { Text, Title } = Typography;

export interface EventStreamPanelProps {
  collapsed: boolean;
  onToggleCollapse?: () => void;
  events: SocketEvent[];
  onClear: () => void;
  width?: number | string;
}

export const EventStreamPanel: React.FC<EventStreamPanelProps> = ({
  collapsed,
  onToggleCollapse,
  events,
  onClear,
  width = 600,
}) => {
  const { token } = theme.useToken();
  const [includeCursor, setIncludeCursor] = useState(false);
  const [includeMessages, setIncludeMessages] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

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
      // Filter cursor events
      if (!includeCursor && event.type === 'cursor') {
        return false;
      }
      // Filter message events
      if (!includeMessages && event.type === 'message') {
        return false;
      }
      return true;
    });
  }, [displayEvents, includeCursor, includeMessages]);

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
        width,
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
          <Badge
            count={displayCount}
            showZero
            style={{ backgroundColor: token.colorPrimaryBgHover }}
          />
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
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          Filters:
        </Text>
        <Space direction="vertical" size="small">
          <Checkbox checked={includeCursor} onChange={(e) => setIncludeCursor(e.target.checked)}>
            <Text style={{ fontSize: 13 }}>Include cursor movement</Text>
          </Checkbox>
          <Checkbox
            checked={includeMessages}
            onChange={(e) => setIncludeMessages(e.target.checked)}
          >
            <Text style={{ fontSize: 13 }}>Include message streams</Text>
          </Checkbox>
        </Space>
        {totalCount !== displayCount && (
          <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 11 }}>
            Showing {displayCount} of {totalCount} events
          </Text>
        )}
        {isPaused && missedCount > 0 && (
          <Text type="warning" style={{ display: 'block', marginTop: 8, fontSize: 11 }}>
            {missedCount} new events captured while paused
          </Text>
        )}
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
              <EventItem key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
