/**
 * ThinkingBlock - Displays Claude's extended thinking content
 *
 * Features:
 * - Collapsible thinking content (collapsed by default to reduce noise)
 * - Supports streaming updates in real-time
 * - Markdown rendering for structured thinking
 * - Visual distinction from regular message content
 */

import { BulbOutlined, DownOutlined, RightOutlined } from '@ant-design/icons';
import { Collapse, Typography, theme } from 'antd';
import type React from 'react';
import { CollapsibleText } from '../CollapsibleText';
import { TEXT_TRUNCATION } from '../../constants/ui';

const { Text } = Typography;

interface ThinkingBlockProps {
  /** Thinking content (markdown) */
  content: string;
  /** Whether content is still streaming */
  isStreaming?: boolean;
  /** Whether to default to expanded state */
  defaultExpanded?: boolean;
}

/**
 * ThinkingBlock - Collapsible thinking content display
 *
 * Shows Claude's extended thinking process in a visually distinct,
 * collapsible block. Defaults to collapsed to keep conversation focused
 * on actual responses.
 */
export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({
  content,
  isStreaming = false,
  defaultExpanded = false,
}) => {
  const { token } = theme.useToken();

  // Don't render if no content
  if (!content && !isStreaming) {
    return null;
  }

  const thinkingHeader = (
    <div style={{ display: 'flex', alignItems: 'center', gap: token.sizeUnit }}>
      <BulbOutlined style={{ color: token.colorTextSecondary, fontSize: 14 }} />
      <Text type="secondary" style={{ fontSize: 13 }}>
        Extended Thinking
        {isStreaming && ' (streaming...)'}
      </Text>
    </div>
  );

  return (
    <Collapse
      defaultActiveKey={defaultExpanded ? ['thinking'] : []}
      expandIcon={({ isActive }) => (isActive ? <DownOutlined /> : <RightOutlined />)}
      style={{
        background: 'rgba(250, 173, 20, 0.05)', // Soft yellow/amber background
        border: `1px solid ${token.colorWarningBorder}`,
        borderRadius: token.borderRadius,
        marginBottom: token.sizeUnit * 1.5,
      }}
      items={[
        {
          key: 'thinking',
          label: thinkingHeader,
          style: { border: 'none' },
          styles: {
            header: {
              padding: `${token.sizeUnit * 0.75}px ${token.sizeUnit * 1.5}px`,
              background: 'transparent',
              border: 'none',
            },
            body: {
              padding: `${token.sizeUnit}px ${token.sizeUnit * 1.5}px`,
              paddingTop: 0,
              background: 'transparent',
            },
          },
          children: (
            <div
              style={{
                fontSize: 13,
                whiteSpace: 'pre-wrap',
              }}
            >
              <div style={{ color: token.colorTextTertiary }}>
                {content ? (
                  <CollapsibleText
                    maxLines={TEXT_TRUNCATION.DEFAULT_LINES}
                    preserveWhitespace
                    style={{ fontSize: 13, marginBottom: 0 }}
                  >
                    {content}
                  </CollapsibleText>
                ) : (
                  <Text>Thinking...</Text>
                )}
              </div>
            </div>
          ),
        },
      ]}
    />
  );
};
