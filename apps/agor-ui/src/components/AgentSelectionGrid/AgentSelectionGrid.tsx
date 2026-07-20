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

import type { TenantAgenticToolName } from '@agor-live/client';
import { Select, Space, Typography } from 'antd';
import { useEffect } from 'react';
import { useAgorStore } from '../../store/agorStore';
import type { AgenticToolOption } from '../../types';
import { AgentSelectionCard } from '../AgentSelectionCard';
import { Tag } from '../Tag';
import { ToolIcon } from '../ToolIcon';

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
  columns?: 2 | 3;
  /** Show helper text when no agent selected (cards variant only) */
  showHelperText?: boolean;
  /** Helper text to display (cards variant only) */
  helperText?: string;
  /** Show SDK comparison link (both variants) */
  showComparisonLink?: boolean;
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
}) => {
  const settings = useAgorStore((state) => state.agenticToolSettingsByName);
  const visibleAgents = agents.filter((agent) => {
    const canonical = agent.id === 'claude-code-cli' ? 'claude-code' : agent.id;
    return settings.get(canonical as TenantAgenticToolName)?.enabled !== false;
  });
  useEffect(() => {
    if (
      selectedAgentId &&
      !visibleAgents.some((agent) => agent.id === selectedAgentId) &&
      visibleAgents[0]
    ) {
      onSelect(visibleAgents[0].id);
    }
  }, [onSelect, selectedAgentId, visibleAgents]);
  if (variant === 'select') {
    return (
      <>
        <Select
          value={selectedAgentId ?? undefined}
          onChange={(id) => onSelect(id)}
          style={{ width: '100%' }}
          options={visibleAgents.map((agent) => ({
            value: agent.id,
            label: (
              <Space size={8}>
                <ToolIcon tool={agent.id} size={16} />
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
      {showHelperText && !selectedAgentId && (
        <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
          {helperText}
        </Text>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 6,
          marginTop: 8,
        }}
      >
        {visibleAgents.map((agent) => (
          <AgentSelectionCard
            key={agent.id}
            agent={agent}
            selected={selectedAgentId === agent.id}
            onClick={() => onSelect(agent.id)}
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
