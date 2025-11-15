/**
 * CompactionBlock - Renders compaction events (start + optional complete)
 *
 * Handles aggregation of compaction system messages:
 * - system_status (compacting) → Shows spinner
 * - system_complete (compaction) → Shows completion with metadata
 *
 * Receives an array of messages (sorted chronologically):
 * - [start] → Spinner (in progress)
 * - [start, complete] → Completion UI with metadata
 */

import type { Message } from '@agor/core/types';
import { CheckCircleFilled, RobotOutlined } from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Space, Spin, Typography, theme } from 'antd';
import type React from 'react';
import { AgorAvatar } from '../AgorAvatar';
import { ToolIcon } from '../ToolIcon';

const { Text } = Typography;

interface CompactionBlockProps {
  messages: Message[]; // Array of system messages (start, complete)
  agentic_tool?: string;
}

export const CompactionBlock: React.FC<CompactionBlockProps> = ({ messages, agentic_tool }) => {
  const { token } = theme.useToken();

  // Find start and complete messages
  const startMessage = messages.find((m) => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(
      (b) => b.type === 'system_status' && 'status' in b && b.status === 'compacting'
    );
  });

  const completeMessage = messages.find((m) => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(
      (b) => b.type === 'system_complete' && 'systemType' in b && b.systemType === 'compaction'
    );
  });

  const avatar = agentic_tool ? (
    <ToolIcon tool={agentic_tool} size={32} />
  ) : (
    <AgorAvatar icon={<RobotOutlined />} style={{ backgroundColor: token.colorBgContainer }} />
  );

  // If we have complete message, show completion state
  if (completeMessage && Array.isArray(completeMessage.content)) {
    const completeBlock = completeMessage.content.find(
      (b) => b.type === 'system_complete' && 'systemType' in b && b.systemType === 'compaction'
    );

    if (completeBlock) {
      // Extract metadata from complete block
      const trigger = ('trigger' in completeBlock ? completeBlock.trigger : undefined) as
        | string
        | undefined;
      const preTokens = ('pre_tokens' in completeBlock ? completeBlock.pre_tokens : undefined) as
        | number
        | undefined;

      // Calculate duration from start and complete timestamps
      const duration =
        startMessage && completeMessage
          ? new Date(completeMessage.timestamp).getTime() -
            new Date(startMessage.timestamp).getTime()
          : null;

      return (
        <div style={{ margin: `${token.sizeUnit}px 0` }}>
          <Bubble
            placement="start"
            avatar={avatar}
            content={
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Space>
                  <CheckCircleFilled style={{ color: token.colorSuccess, fontSize: 14 }} />
                  <Text type="secondary">Context compacted successfully</Text>
                </Space>
                {/* Show metadata if available */}
                {(trigger || preTokens || duration) && (
                  <div
                    style={{
                      fontSize: 12,
                      color: token.colorTextTertiary,
                      paddingLeft: 22,
                    }}
                  >
                    {trigger && <div>Trigger: {trigger}</div>}
                    {preTokens && <div>Pre-compaction tokens: {preTokens.toLocaleString()}</div>}
                    {duration && <div>Duration: {(duration / 1000).toFixed(2)}s</div>}
                  </div>
                )}
              </Space>
            }
            variant="outlined"
          />
        </div>
      );
    }
  }

  // Otherwise, show in-progress state (spinner)
  return (
    <div style={{ margin: `${token.sizeUnit}px 0` }}>
      <Bubble
        placement="start"
        avatar={avatar}
        content={
          <Space>
            <Spin size="small" />
            <Text type="secondary">Compacting conversation context...</Text>
          </Space>
        }
        variant="outlined"
      />
    </div>
  );
};
