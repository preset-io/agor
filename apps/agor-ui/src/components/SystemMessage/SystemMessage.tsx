/**
 * SystemMessage - Generic system message component with collapsible raw payload
 *
 * Provides shared chrome (avatar, bubble, optional collapsed raw JSON) for all
 * system message types. Specific components (RateLimitBlock, CompactionBlock, etc.)
 * compose this by passing formatted content and raw payload.
 */

import { RobotOutlined } from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Button, theme } from 'antd';
import type React from 'react';
import { useId, useState } from 'react';
import { AgorAvatar } from '../AgorAvatar';
import { ToolIcon } from '../ToolIcon';

interface SystemMessageProps {
  /** The formatted, human-readable content (icon + text + metadata) */
  content: React.ReactNode;
  /** Optional raw payload — when provided, renders a collapsed "Details" toggle showing JSON */
  raw?: unknown;
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
  const detailsId = useId();

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
            {raw != null && (
              <div style={{ marginTop: token.sizeUnit }}>
                <Button
                  type="text"
                  size="small"
                  onClick={() => setRawExpanded(!rawExpanded)}
                  aria-expanded={rawExpanded}
                  aria-controls={detailsId}
                  style={{
                    fontSize: 11,
                    color: token.colorTextQuaternary,
                    padding: '0 4px',
                    height: 'auto',
                    lineHeight: 'inherit',
                  }}
                >
                  {rawExpanded ? '▼' : '▶'} Details
                </Button>
                {rawExpanded && (
                  <pre
                    id={detailsId}
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
