/**
 * RateLimitBlock - Renders rate limit, API wait, and SDK events
 *
 * Handles system messages with content types:
 * - rate_limit → Shows rate limit info with status and reset time
 * - api_wait → Shows API delay warning
 * - sdk_event → Shows unhandled SDK events (blacklist approach: surface by default)
 */

import type { Message } from '@agor/core/types';
import {
  ClockCircleOutlined,
  InfoCircleOutlined,
  RobotOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Space, Typography, theme } from 'antd';
import type React from 'react';
import { AgorAvatar } from '../AgorAvatar';
import { ToolIcon } from '../ToolIcon';

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

  const avatar = agentic_tool ? (
    <ToolIcon tool={agentic_tool} size={32} />
  ) : (
    <AgorAvatar icon={<RobotOutlined />} style={{ backgroundColor: token.colorBgContainer }} />
  );

  return (
    <div style={{ margin: `${token.sizeUnit}px 0` }}>
      <Bubble
        placement="start"
        avatar={avatar}
        content={
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
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
        }
        variant="outlined"
      />
    </div>
  );
};
