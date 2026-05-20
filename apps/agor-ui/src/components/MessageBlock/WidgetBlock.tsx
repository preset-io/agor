/**
 * WidgetBlock — in-conversation widget dispatcher.
 *
 * Switches on `message.metadata.widget.widget_type` and renders the matching
 * widget component. In PR 1 the client-side widget registry is empty; the
 * fallback renders an "Unknown widget type" placeholder so newer servers
 * that ship widget types unknown to an older client degrade gracefully
 * instead of crashing.
 *
 * See `docs/internal/in-conversation-widgets-design-2026-05-19.md`.
 */

import type { AgorClient, Message, WidgetMessageMetadata, WidgetType } from '@agor-live/client';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import { Card, Space, Typography, theme } from 'antd';
import type React from 'react';

const { Text } = Typography;

export interface WidgetComponentProps {
  message: Message;
  widget: WidgetMessageMetadata;
  /**
   * Authenticated Feathers client. Widget components MUST submit via
   * `client.service(...).create(...)` rather than raw fetch so the
   * built-in 401 refresh/retry hook applies and tokens stay in sync.
   * `null` if no session is active.
   */
  client: AgorClient | null;
}

/**
 * Per-widget-type renderers. Each widget type registers itself via
 * `registerWidgetComponent` at module load. PR 1 ships an empty registry;
 * PR 2 (env_vars), PR 3 (confirmation), etc. populate it.
 */
const widgetComponents = new Map<WidgetType, React.FC<WidgetComponentProps>>();

export function registerWidgetComponent(
  type: WidgetType,
  component: React.FC<WidgetComponentProps>
): void {
  widgetComponents.set(type, component);
}

interface WidgetBlockProps {
  message: Message;
  client: AgorClient | null;
}

/**
 * Render a `type === 'widget_request'` message. Looks up the registered
 * component for `widget.widget_type`; falls back to a forward-compat
 * placeholder.
 */
export const WidgetBlock: React.FC<WidgetBlockProps> = ({ message, client }) => {
  const { token } = theme.useToken();
  const widget = message.metadata?.widget;

  if (!widget) {
    // Defensive: a widget_request message should always have metadata.widget;
    // if it doesn't, render nothing rather than crashing the transcript.
    return null;
  }

  const Component = widgetComponents.get(widget.widget_type);

  if (!Component) {
    return (
      <Card
        size="small"
        style={{
          margin: `${token.sizeUnit * 1.5}px 0`,
          background: token.colorBgContainer,
          border: `1px dashed ${token.colorBorder}`,
        }}
      >
        <Space>
          <ExclamationCircleOutlined style={{ color: token.colorWarning }} />
          <Space direction="vertical" size={0}>
            <Text strong>Unknown widget type — update your client</Text>
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              The agent requested a <code>{widget.widget_type}</code> widget, but this client
              doesn't know how to render it. Status: {renderStatusBadge(widget.status)}
            </Text>
          </Space>
        </Space>
      </Card>
    );
  }

  return <Component message={message} widget={widget} client={client} />;
};

function renderStatusBadge(status: WidgetMessageMetadata['status']): React.ReactNode {
  switch (status) {
    case 'submitted':
      return (
        <>
          <CheckCircleOutlined /> submitted
        </>
      );
    case 'dismissed':
      return (
        <>
          <MinusCircleOutlined /> dismissed
        </>
      );
    case 'already_present':
      return (
        <>
          <CheckCircleOutlined /> already configured
        </>
      );
    default:
      return <Text>pending</Text>;
  }
}

/**
 * Public helper used by tests / future PRs to inspect registry state. Not
 * intended for use in production rendering — components should always
 * dispatch through `WidgetBlock`.
 */
export function _listRegisteredWidgetTypes(): WidgetType[] {
  return Array.from(widgetComponents.keys());
}
