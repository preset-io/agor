/**
 * RateLimitBlock - Renders rate limit, API wait, and SDK events
 *
 * Handles system messages with content types:
 * - rate_limit → Shows rate limit info with status and reset time
 * - api_wait → Shows API delay warning
 * - sdk_event → Shows unhandled SDK events (blacklist approach: surface by default)
 */

import type { Message } from '@agor-live/client';
import { ClockCircleOutlined, InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Space, Typography, theme } from 'antd';
import type React from 'react';
import { SystemMessage } from '../SystemMessage';

const { Text } = Typography;

interface RateLimitBlockProps {
  message: Message;
  agentic_tool?: string;
}

export const RateLimitBlock: React.FC<RateLimitBlockProps> = ({ message, agentic_tool }) => {
  const { token } = theme.useToken();

  if (!Array.isArray(message.content)) return null;

  const rateLimitBlock = message.content.find((b) => b.type === 'rate_limit');
  const apiWaitBlock = message.content.find((b) => b.type === 'api_wait');
  const sdkEventBlock = message.content.find((b) => b.type === 'sdk_event');

  const block = rateLimitBlock || apiWaitBlock || sdkEventBlock;
  if (!block) return null;

  // Defensive filter: hide already-persisted system/status messages with status='requesting'.
  // Server-side filter in message-processor.ts drops these going forward; this catches noise
  // already in the DB from sessions created between the SDK bump and this fix.
  if (
    block.type === 'sdk_event' &&
    'sdkType' in block &&
    block.sdkType === 'system' &&
    'sdkSubtype' in block &&
    block.sdkSubtype === 'status' &&
    'metadata' in block &&
    typeof block.metadata === 'object' &&
    block.metadata !== null &&
    (block.metadata as { status?: unknown }).status === 'requesting'
  ) {
    return null;
  }

  const text = ('text' in block ? block.text : '') as string;
  const isRateLimit = block.type === 'rate_limit';
  const isSdkEvent = block.type === 'sdk_event';
  const status = isRateLimit && 'status' in block ? (block.status as string) : undefined;
  const rateLimitType =
    isRateLimit && 'rateLimitType' in block ? (block.rateLimitType as string) : undefined;
  const resetsAt = isRateLimit && 'resetsAt' in block ? (block.resetsAt as number) : undefined;
  const waitMs = !isRateLimit && 'waitMs' in block ? (block.waitMs as number) : undefined;
  const sdkType = isSdkEvent && 'sdkType' in block ? (block.sdkType as string) : undefined;
  const sdkSubtype = isSdkEvent && 'sdkSubtype' in block ? (block.sdkSubtype as string) : undefined;

  const isWarning = isRateLimit && status !== 'allowed';
  const iconColor = isWarning ? token.colorWarning : token.colorTextTertiary;

  const icon = isRateLimit ? (
    <WarningOutlined style={{ color: iconColor, fontSize: 14 }} />
  ) : isSdkEvent ? (
    <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 14 }} />
  ) : (
    <ClockCircleOutlined style={{ color: iconColor, fontSize: 14 }} />
  );

  const formattedContent = (
    <Space orientation="vertical" size="small" style={{ width: '100%' }}>
      <Space>
        {icon}
        <Text type="secondary">{text}</Text>
      </Space>
      {/* Show metadata details */}
      {(rateLimitType || resetsAt || waitMs || sdkType) && (
        <div
          style={{
            fontSize: 12,
            color: token.colorTextTertiary,
            paddingLeft: 22,
          }}
        >
          {rateLimitType && <div>Type: {rateLimitType}</div>}
          {resetsAt && <div>Resets: {new Date(resetsAt * 1000).toLocaleString()}</div>}
          {waitMs && <div>Wait time: {(waitMs / 1000).toFixed(1)}s</div>}
          {sdkType && (
            <div>
              Source: {sdkType}
              {sdkSubtype ? `/${sdkSubtype}` : ''}
            </div>
          )}
        </div>
      )}
    </Space>
  );

  return <SystemMessage content={formattedContent} raw={block} agenticTool={agentic_tool} />;
};
