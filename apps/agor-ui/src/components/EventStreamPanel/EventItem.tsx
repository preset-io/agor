/**
 * EventItem - Display a single socket event with timestamp, type, and data
 */

import {
  AimOutlined,
  ApiOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Button, Popover, Tag, Typography, theme } from 'antd';
import React from 'react';
import type { SocketEvent } from '../../hooks/useEventStream';

const { Text } = Typography;

export interface EventItemProps {
  event: SocketEvent;
}

export const EventItem = ({ event }: EventItemProps): React.JSX.Element => {
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
        alignItems: 'center',
        gap: 8,
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

      <>
        {event.data && (
          <Popover content={detailsContent} title="Event Data" trigger="click" placement="left">
            <Button
              type="text"
              size="small"
              icon={<InfoCircleOutlined />}
              style={{ padding: '0 4px' }}
            />
          </Popover>
        )}
      </>
    </div>
  );
};
