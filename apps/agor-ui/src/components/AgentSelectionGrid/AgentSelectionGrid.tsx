/**
 * Agent Selection Grid
 *
 * Reusable component for picking an agentic tool. Two variants:
 *
 * - `variant="cards"` (default) — grid of AgentSelectionCard, used when the
 *   modal wants to highlight each agent's pitch (e.g. NewSessionModal).
 * - `variant="select"` — single Antd Select dropdown, used when the picker
 *   should stay out of the way (e.g. ScheduleModal, where the prompt + cron
 *   matter more than which agent runs them).
 *
 * Used in:
 * - NewSessionModal (cards, 2 columns)
 * - ForkSpawnModal (cards, 2 columns)
 * - ScheduleModal (select)
 */

import type { AgenticToolName, TenantAgenticToolName } from '@agor-live/client';
import { Alert, Select, Space, Spin, Typography, theme } from 'antd';
import { useEffect, useMemo } from 'react';
import { useAgorStore } from '../../store/agorStore';
import type { AgenticToolOption } from '../../types';
import { AgentSelectionCard } from '../AgentSelectionCard';
import { Tag } from '../Tag';
import { ToolIcon } from '../ToolIcon';
import { resolveAvailableAgenticTool } from './availableAgents';

const { Text } = Typography;

// Re-export for backwards compatibility
export type { AgenticToolOption };

export interface AgentSelectionGridProps {
  /** Available agents to display */
  agents: AgenticToolOption[];
  /** Currently selected agent ID */
  selectedAgentId: string | null;
  /** Callback when an agent is selected */
  onSelect: (agentId: string) => void;
  /** Rendering style. `cards` (default) = grid of cards; `select` = compact Antd Select. */
  variant?: 'cards' | 'select';
  /** Number of columns (cards variant only) */
  columns?: 2 | 3 | 4;
  /** Show helper text when no agent selected (cards variant only) */
  showHelperText?: boolean;
  /** Helper text to display (cards variant only) */
  helperText?: string;
  /** Show SDK comparison link (both variants) */
  showComparisonLink?: boolean;
  /** Card density (cards variant only). `small` uses the dense half-height tile. */
  size?: 'default' | 'small';
  /**
   * Opt-in fallback for creation flows whose default tool is unavailable.
   *
   * Persisted-edit flows must leave this false so opening an old/disabled
   * value never silently invokes onSelect with a different tool.
   */
  fallbackToFirstVisibleAgent?: boolean;
}

export const AgentSelectionGrid: React.FC<AgentSelectionGridProps> = ({
  agents,
  selectedAgentId,
  onSelect,
  variant = 'cards',
  columns = 3,
  showHelperText = false,
  helperText = 'Click on an agent card to select it',
  showComparisonLink = false,
  size = 'default',
  fallbackToFirstVisibleAgent = false,
}) => {
  const { token } = theme.useToken();
  const settings = useAgorStore((state) => state.agenticToolSettingsByName);
  const settingsHydrated = useAgorStore((state) => state.agenticToolSettingsHydrated);
  const visibleAgents = useMemo(
    () =>
      settingsHydrated
        ? agents.filter(
            (agent) => settings.get(agent.id as TenantAgenticToolName)?.enabled !== false
          )
        : [],
    [agents, settings, settingsHydrated]
  );
  useEffect(() => {
    if (fallbackToFirstVisibleAgent && selectedAgentId && visibleAgents.length > 0) {
      const resolved = resolveAvailableAgenticTool(
        selectedAgentId as AgenticToolName,
        settings,
        agents
      );
      if (resolved !== selectedAgentId) onSelect(resolved);
    }
  }, [
    agents,
    fallbackToFirstVisibleAgent,
    onSelect,
    selectedAgentId,
    settings,
    visibleAgents.length,
  ]);
  if (!settingsHydrated) {
    return (
      <div
        role="status"
        aria-label="Loading agentic tool availability"
        style={{ display: 'flex', justifyContent: 'center', padding: token.paddingLG }}
      >
        <Spin size="small" />
      </div>
    );
  }
  if (variant === 'select') {
    return (
      <>
        {visibleAgents.length === 0 && (
          <Alert
            type="warning"
            showIcon
            title="No agentic tools are enabled for this workspace"
            description="Contact a workspace administrator. Deployment package changes require a separate deployment operator."
            style={{ marginBottom: token.marginSM }}
          />
        )}
        <Select
          value={selectedAgentId ?? undefined}
          onChange={(id) => onSelect(id)}
          style={{ width: '100%' }}
          options={visibleAgents.map((agent) => ({
            value: agent.id,
            label: (
              <Space size={8} align="center">
                {/* height:0 stops the badge inflating the single-line control; the small
                    translate re-centers it (the badge is baseline-, not center-aligned). */}
                <span
                  style={{
                    display: 'inline-flex',
                    height: 0,
                    alignItems: 'center',
                    transform: 'translateY(3px)',
                  }}
                >
                  <ToolIcon tool={agent.id} size={16} />
                </span>
                <span>{agent.name}</span>
                {agent.beta && <Tag color="warning">BETA</Tag>}
              </Space>
            ),
          }))}
        />
        {showComparisonLink && <ComparisonLink />}
      </>
    );
  }

  return (
    <>
      {visibleAgents.length === 0 && (
        <Alert
          type="warning"
          showIcon
          title="No agentic tools are enabled for this workspace"
          description="Contact a workspace administrator. Deployment package changes require a separate deployment operator."
        />
      )}
      {showHelperText && !selectedAgentId && (
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
          {helperText}
        </Text>
      )}
      <div
        style={{
          display: 'grid',
          // Dense tiles use auto-fit so they always wrap within the container
          // instead of overflowing; the fixed-column layout is unchanged for the
          // default variant. `minmax(min, 1fr)` caps the min track width.
          gridTemplateColumns:
            size === 'small'
              ? `repeat(auto-fit, minmax(${token.sizeXXL * 3}px, 1fr))`
              : `repeat(${columns}, 1fr)`,
          // Small tiles use the token scale; the default variant keeps #1801's
          // tightened 6px gap.
          gap: size === 'small' ? token.marginXS : 6,
          marginTop: token.marginXS,
        }}
      >
        {visibleAgents.map((agent) => (
          <AgentSelectionCard
            key={agent.id}
            agent={agent}
            selected={selectedAgentId === agent.id}
            onClick={() => onSelect(agent.id)}
            size={size}
          />
        ))}
      </div>
      {showComparisonLink && <ComparisonLink />}
    </>
  );
};

const ComparisonLink: React.FC = () => (
  <Text
    type="secondary"
    style={{ fontSize: 11, marginTop: 8, display: 'block', textAlign: 'center' }}
  >
    Compare features:{' '}
    <a href="https://agor.live/guide/sdk-comparison" target="_blank" rel="noopener noreferrer">
      SDK Comparison Guide
    </a>
  </Text>
);
