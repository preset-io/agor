import { ExperimentOutlined } from '@ant-design/icons';
import { Card, Flex, Space, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';
import type { AgenticToolOption } from '../../types';
import { Tag } from '../Tag';
import { ToolIcon } from '../ToolIcon';

export interface AgentSelectionCardProps {
  agent: AgenticToolOption;
  selected?: boolean;
  onClick?: () => void;
  /**
   * `default` (full) shows the version and description inline. `small` is a
   * denser, roughly half-height tile: icon + name + BETA, with the description
   * moved to a tooltip. Additive — omit for the original rendering.
   */
  size?: 'default' | 'small';
}

export const AgentSelectionCard: React.FC<AgentSelectionCardProps> = ({
  agent,
  selected = false,
  onClick,
  size = 'default',
}) => {
  const { token } = theme.useToken();
  // While the beta icon (which has its own tooltip) is hovered, force the
  // card-level description tooltip closed so the two don't stack.
  const [betaHovered, setBetaHovered] = useState(false);

  const cardStyle: React.CSSProperties = {
    borderColor: selected ? token.colorPrimary : undefined,
    borderWidth: selected ? 2 : 1,
    cursor: 'pointer',
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onClick?.();
  };

  if (size === 'small') {
    return (
      <Tooltip title={agent.description} open={betaHovered ? false : undefined}>
        <Card
          hoverable
          role="button"
          tabIndex={0}
          aria-label={agent.name}
          aria-pressed={selected}
          onClick={onClick}
          onKeyDown={handleKeyDown}
          style={cardStyle}
          styles={{ body: { padding: token.paddingXS } }}
        >
          <Flex align="center" gap={token.marginXS} style={{ width: '100%' }}>
            <ToolIcon tool={agent.id} size={token.sizeMD} />
            {/* flex:1 + minWidth:0 lets the name take all remaining width; the
                icon-only beta badge sits outside it so names never truncate. */}
            <Typography.Text
              strong
              ellipsis
              style={{ fontSize: token.fontSizeSM, flex: 1, minWidth: 0 }}
            >
              {agent.name}
            </Typography.Text>
            {agent.beta && (
              // Hovering the beta icon suppresses the card's general tooltip so
              // the two don't render stacked. Handlers live on this outer span
              // (not the Tooltip child) so antd's trigger cloning can't drop them.
              <span
                onMouseEnter={() => setBetaHovered(true)}
                onMouseLeave={() => setBetaHovered(false)}
                style={{ display: 'inline-flex' }}
              >
                <Tooltip title="In beta — this agent integration is still stabilizing">
                  <ExperimentOutlined
                    aria-label="Beta"
                    style={{ color: token.colorWarning, fontSize: token.fontSizeSM }}
                  />
                </Tooltip>
              </span>
            )}
          </Flex>
        </Card>
      </Tooltip>
    );
  }

  return (
    <Card
      hoverable
      role="button"
      tabIndex={0}
      aria-label={agent.name}
      aria-pressed={selected}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      style={cardStyle}
      styles={{ body: { padding: 8 } }}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size={3}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} size={6}>
          <Space size={6}>
            <ToolIcon tool={agent.id} size={20} />
            <Typography.Text strong style={{ fontSize: '13px' }}>
              {agent.name}
            </Typography.Text>
            {agent.beta && <Tag color="warning">BETA</Tag>}
          </Space>
        </Space>

        {agent.version && (
          <Typography.Text type="secondary" style={{ fontSize: '10px' }}>
            Version: {agent.version}
          </Typography.Text>
        )}

        {agent.description && (
          <Typography.Text type="secondary" style={{ fontSize: '11px' }}>
            {agent.description}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
};
