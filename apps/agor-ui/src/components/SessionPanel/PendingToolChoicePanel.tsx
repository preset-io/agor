/**
 * PendingToolChoicePanel — quick-start empty state
 *
 * Shown in place of the session drawer's conversation + composer when
 * "Add session" can't resolve a tool on its own (no preference, no prior
 * session for this user). Rather than blocking on the old modal, the drawer
 * still opens immediately with this panel: tiles instead of a form, one per
 * available agentic tool. Picking one creates the session and this panel is
 * swapped out for the real `SessionPanel`.
 *
 * Chrome (header layout, footer bar shape/spacing, muted secondary copy)
 * mirrors `SessionPanel`'s own header/footer and the Connect-AI empty state
 * (`MissingCredentialPanel`, feature-connect-ai-empty-state) so the drawer
 * doesn't visibly change shape between "picking a tool" and "using a
 * session" — just swap tiles for a form, same panel chrome throughout.
 *
 * The composer bar below the tiles is intentionally inert (not hidden): a
 * disabled textarea + send + options button in the same position the real
 * `SessionFooter` renders them, so there's no valid-looking-but-broken
 * affordance before a tool is chosen. It unlocks the instant a tile is
 * picked, when this panel unmounts in favor of the real session.
 */

import type { AgenticToolName, Branch } from '@agor-live/client';
import { CloseOutlined, RobotOutlined, SendOutlined, SettingOutlined } from '@ant-design/icons';
import { Button, Flex, Input, Spin, Typography, theme } from 'antd';
import type React from 'react';
import { useState } from 'react';
import {
  type AgenticToolOption,
  AgentSelectionGrid,
} from '../AgentSelectionGrid/AgentSelectionGrid';

export interface PendingToolChoicePanelProps {
  branch: Branch | null;
  availableAgents: AgenticToolOption[];
  onChoose: (tool: AgenticToolName) => void | Promise<void>;
  onClose: () => void;
  /** Escape hatch for the rare case someone wants title/prompt/MCP/env vars set up front. */
  onAdvancedSetup?: () => void;
}

export const PendingToolChoicePanel: React.FC<PendingToolChoicePanelProps> = ({
  branch,
  availableAgents,
  onChoose,
  onClose,
  onAdvancedSetup,
}) => {
  const { token } = theme.useToken();
  const [choosingTool, setChoosingTool] = useState<string | null>(null);

  const handleChoose = async (toolId: string) => {
    if (choosingTool) return;
    setChoosingTool(toolId);
    try {
      await onChoose(toolId as AgenticToolName);
    } finally {
      setChoosingTool(null);
    }
  };

  return (
    <Flex
      vertical
      style={{
        width: '100%',
        height: '100%',
        background: token.colorBgElevated,
        borderLeft: `1px solid ${token.colorBorder}`,
      }}
    >
      {/* Header — mirrors SessionPanel's header chrome */}
      <Flex
        justify="space-between"
        align="center"
        style={{
          flexShrink: 0,
          padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px`,
          borderBottom: `1px solid ${token.colorBorder}`,
          background: token.colorBgContainer,
        }}
      >
        <Flex align="center" gap={12} style={{ minWidth: 0 }}>
          <RobotOutlined style={{ fontSize: 28, color: token.colorTextTertiary, flexShrink: 0 }} />
          <Typography.Text strong style={{ fontSize: 18 }}>
            {branch ? `Untitled session — ${branch.name}` : 'Untitled session'}
          </Typography.Text>
        </Flex>
        <Button type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close panel" />
      </Flex>

      {/* Body — tile picker, one per available agentic tool */}
      <Flex
        vertical
        align="center"
        justify="center"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: token.sizeUnit * 6,
        }}
      >
        <div style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
          <Typography.Text style={{ fontSize: 13 }} type="secondary">
            Choose which AI tool this session should use.
          </Typography.Text>

          <Flex
            vertical
            style={{ marginTop: token.marginSM, textAlign: 'left', position: 'relative' }}
          >
            <AgentSelectionGrid
              agents={availableAgents}
              selectedAgentId={choosingTool}
              onSelect={handleChoose}
              columns={2}
            />
            {choosingTool && (
              <Flex
                align="center"
                justify="center"
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: token.colorBgElevated,
                  opacity: 0.7,
                }}
              >
                <Spin size="small" />
              </Flex>
            )}
          </Flex>

          {onAdvancedSetup && (
            <Button
              type="link"
              size="small"
              onClick={onAdvancedSetup}
              disabled={!!choosingTool}
              style={{
                marginTop: token.marginSM,
                color: token.colorLink,
                // antd buttons default to `white-space: nowrap` + a fixed
                // single-line height, so any text longer than the panel is
                // silently clipped rather than wrapped. Force a real
                // multi-line button so this can't recur if the copy grows.
                whiteSpace: 'normal',
                height: 'auto',
                width: '100%',
                textAlign: 'center',
                padding: `${token.paddingXXS}px ${token.paddingSM}px`,
              }}
            >
              Need more control? Go to advanced setup
            </Button>
          )}
        </div>
      </Flex>

      {/* Footer — same position/shape as SessionFooter, inert until a tile is picked */}
      <Flex
        vertical
        style={{
          flexShrink: 0,
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorder}`,
          padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 6}px ${token.sizeUnit * 3}px`,
        }}
      >
        <Input.TextArea
          disabled
          placeholder="Pick a tool above to start typing…"
          autoSize={{ minRows: 2, maxRows: 2 }}
        />
        <Flex
          align="center"
          gap={token.sizeUnit}
          style={{
            marginTop: token.sizeUnit * 2,
          }}
        >
          <Button size="small" type="text" icon={<SettingOutlined />} disabled>
            Options
          </Button>
          <div style={{ flex: 1 }} />
          <Button size="small" type="primary" icon={<SendOutlined />} disabled>
            Send
          </Button>
        </Flex>
      </Flex>
    </Flex>
  );
};
