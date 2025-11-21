/**
 * Agent Selection Grid
 *
 * Reusable component for displaying agent selection cards in a grid layout.
 * Uses 3-column layout by default for a compact, side-by-side view.
 *
 * Used in:
 * - NewSessionModal (3 columns)
 * - ScheduleTab (3 columns)
 */

import { Typography } from 'antd';
import type { AgenticToolOption } from '../../types';
import { AgentSelectionCard } from '../AgentSelectionCard';

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
  /** Number of columns (2 or 3) */
  columns?: 2 | 3;
  /** Show helper text when no agent selected */
  showHelperText?: boolean;
  /** Helper text to display */
  helperText?: string;
  /** Show SDK comparison link */
  showComparisonLink?: boolean;
}

/**
 * Grid of agent selection cards
 *
 * Default: 3 columns for a clean side-by-side layout
 */
export const AgentSelectionGrid: React.FC<AgentSelectionGridProps> = ({
  agents,
  selectedAgentId,
  onSelect,
  columns = 3,
  showHelperText = false,
  helperText = 'Click on an agent card to select it',
  showComparisonLink = false,
}) => {
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
          gap: 8,
          marginTop: 8,
        }}
      >
        {agents.map(agent => (
          <AgentSelectionCard
            key={agent.id}
            agent={agent}
            selected={selectedAgentId === agent.id}
            onClick={() => onSelect(agent.id)}
          />
        ))}
      </div>
      {showComparisonLink && (
        <Text
          type="secondary"
          style={{ fontSize: 11, marginTop: 8, display: 'block', textAlign: 'center' }}
        >
          Compare features:{' '}
          <a
            href="https://agor.live/guide/sdk-comparison"
            target="_blank"
            rel="noopener noreferrer"
          >
            SDK Comparison Guide
          </a>
        </Text>
      )}
    </>
  );
};
