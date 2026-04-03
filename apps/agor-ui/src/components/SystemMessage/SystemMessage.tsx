/**
 * SystemMessage - Generic system message component with collapsible raw payload
 *
 * Provides shared chrome (avatar, bubble, optional collapsed raw JSON) for all
 * system message types. Specific components (RateLimitBlock, CompactionBlock, etc.)
 * compose this by passing formatted content and raw payload.
 */

import { RobotOutlined } from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Typography, theme } from 'antd';
import React, { useState } from 'react';
import { AgorAvatar } from '../AgorAvatar';
import { ToolIcon } from '../ToolIcon';

const { Text } = Typography;

interface SystemMessageProps {
  /** The formatted, human-readable content (icon + text + metadata) */
  content: React.ReactNode;
  /** Optional raw payload — when provided, renders a collapsed "Details" toggle showing JSON */
  raw?: Record<string, unknown>;
  /** Avatar override (defaults to Agor robot avatar) */
  avatar?: React.ReactNode;
  /** Bubble variant (defaults to 'outlined') */
  variant?: 'outlined' | 'filled';
  /** Agentic tool name — used for avatar if no explicit avatar provided */
  agenticTool?: string;
}

export const SystemMessage: React.FC<SystemMessageProps> = ({
  content,
  raw,
  avatar,
  variant = 'outlined',
  agenticTool,
}) => {
  const { token } = theme.useToken();
  const [rawExpanded, setRawExpanded] = useState(false);

  const resolvedAvatar =
    avatar ??
    (agenticTool ? (
      <ToolIcon tool={agenticTool} size={32} />
    ) : (
      <AgorAvatar icon={<RobotOutlined />} style={{ backgroundColor: token.colorBgContainer }} />
    ));

  return (
    <div style={{ margin: `${token.sizeUnit}px 0` }}>
      <Bubble
        placement="start"
        avatar={resolvedAvatar}
        content={
          <div>
            {content}
            {raw && (
              <div style={{ marginTop: token.sizeUnit }}>
                <Text
                  style={{
                    fontSize: 11,
                    color: token.colorTextQuaternary,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  onClick={() => setRawExpanded(!rawExpanded)}
                >
                  {rawExpanded ? '▼' : '▶'} Details
                </Text>
                {rawExpanded && (
                  <pre
                    style={{
                      fontSize: 11,
                      color: token.colorTextQuaternary,
                      fontFamily: 'monospace',
                      margin: `${token.sizeUnit / 2}px 0 0 0`,
                      padding: token.sizeUnit,
                      background: token.colorFillQuaternary,
                      borderRadius: token.borderRadiusSM,
                      overflow: 'auto',
                      maxHeight: 300,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    {JSON.stringify(raw, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        }
        variant={variant}
      />
    </div>
  );
};
