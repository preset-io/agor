/**
 * TaskNestedBlock - Displays nested tool operations from Task tool subsessions
 *
 * Shows operations that were spawned by a Task tool (identified by parent_tool_use_id).
 * Collapsed by default with summary statistics and expandable to show full tool chain.
 */

import type { Message } from '@agor/core/types';
import { DownOutlined, RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Collapse, Space, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { AgentChain } from '../AgentChain';
import { Tag } from '../Tag';

const { Text } = Typography;

interface TaskNestedBlockProps {
  taskToolUseId: string;
  taskInput: Record<string, unknown>;
  messages: Message[];
}

export const TaskNestedBlock: React.FC<TaskNestedBlockProps> = ({
  taskToolUseId,
  taskInput,
  messages,
}) => {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);

  // Extract task metadata
  const subagentType = (taskInput.subagent_type as string) || 'Task';
  const description = (taskInput.description as string) || undefined;

  // Calculate stats from nested messages
  const stats = useMemo(() => {
    const toolNames = new Set<string>();
    let toolCount = 0;
    let successCount = 0;
    let errorCount = 0;

    for (const msg of messages) {
      if (msg.tool_uses) {
        for (const tool of msg.tool_uses) {
          toolNames.add(tool.name);
          toolCount++;
        }
      }

      // Check tool results
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            if (block.is_error) {
              errorCount++;
            } else {
              successCount++;
            }
          }
        }
      }
    }

    return {
      toolNames: Array.from(toolNames),
      toolCount,
      successCount,
      errorCount,
    };
  }, [messages]);

  // Get final summary message (last message with text content)
  const summaryMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter((b) => b.type === 'text');
        if (textBlocks.length > 0) {
          return textBlocks.map((b) => (b as unknown as { text: string }).text).join('\n');
        }
      }
    }
    return undefined;
  }, [messages]);

  const header = (
    <div style={{ width: '100%' }}>
      <Space direction="vertical" size={token.sizeXS} style={{ width: '100%' }}>
        {/* Header line */}
        <Space size="small" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space size="small">
            <Tag icon={<ThunderboltOutlined />} color="purple" style={{ marginRight: 0 }}>
              {subagentType}
            </Tag>
            {description && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {description}
              </Text>
            )}
          </Space>

          {/* Expand icon */}
          <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
            {expanded ? <DownOutlined /> : <RightOutlined />}
          </span>
        </Space>

        {/* Stats line */}
        <Space size="small" split="·" style={{ fontSize: 11, color: token.colorTextSecondary }}>
          <span>
            {stats.toolCount} tool{stats.toolCount !== 1 ? 's' : ''}
          </span>
          {stats.toolNames.length > 0 && <span>{stats.toolNames.join(', ')}</span>}
          {stats.successCount > 0 && (
            <span style={{ color: token.colorSuccess }}>✓ {stats.successCount}</span>
          )}
          {stats.errorCount > 0 && (
            <span style={{ color: token.colorError }}>✗ {stats.errorCount}</span>
          )}
        </Space>

        {/* Summary preview (when collapsed) */}
        {!expanded && summaryMessage && (
          <Text
            type="secondary"
            style={{
              fontSize: 11,
              display: 'block',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {summaryMessage.substring(0, 150)}...
          </Text>
        )}
      </Space>
    </div>
  );

  return (
    <div
      style={{
        margin: `${token.marginSM}px 0`,
        border: '1px solid rgba(114, 46, 209, 0.3)',
        borderRadius: token.borderRadiusLG,
        borderLeftWidth: 3,
        background: 'rgba(114, 46, 209, 0.02)',
      }}
    >
      <Collapse
        ghost
        activeKey={expanded ? ['content'] : []}
        onChange={() => setExpanded(!expanded)}
        style={{ border: 'none' }}
        items={[
          {
            key: 'content',
            label: header,
            showArrow: false,
            children: (
              <div style={{ paddingTop: token.paddingXS }}>
                {/* Render nested operations using AgentChain */}
                <AgentChain messages={messages} />
              </div>
            ),
            styles: {
              header: {
                padding: `${token.paddingSM}px ${token.paddingMD}px`,
                cursor: 'pointer',
                userSelect: 'none',
              },
              body: {
                padding: `0 ${token.paddingMD}px ${token.paddingSM}px`,
              },
            },
          },
        ]}
      />
    </div>
  );
};
