/**
 * The dense (small) tile grid must be overflow-proof: it uses auto-fit tracks
 * so tiles wrap within the container instead of escaping it, while the default
 * variant keeps its fixed-column layout unchanged.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgenticToolOption } from '../../types';
import { AgentSelectionGrid } from './AgentSelectionGrid';
import { AVAILABLE_AGENTS } from './availableAgents';

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({ agenticToolSettingsByName: new Map() }),
}));

const agents: AgenticToolOption[] = [
  { id: 'claude-code', name: 'Claude Code', icon: '🤖', description: 'x' },
  { id: 'opencode', name: 'OpenCode', icon: '🌐', description: 'y', beta: true },
];

function gridEl(container: HTMLElement): HTMLElement {
  return container.querySelector('[style*="grid"]') as HTMLElement;
}

describe('AgentSelectionGrid tile layout', () => {
  it('uses auto-fit responsive tracks for the small variant (no overflow)', () => {
    const { container } = render(
      <AgentSelectionGrid
        agents={agents}
        selectedAgentId="claude-code"
        onSelect={vi.fn()}
        size="small"
      />
    );
    expect(gridEl(container).style.gridTemplateColumns).toContain('auto-fit');
    expect(gridEl(container).style.gridTemplateColumns).toContain('minmax');
  });

  it('keeps fixed columns for the default variant', () => {
    const { container } = render(
      <AgentSelectionGrid
        agents={agents}
        selectedAgentId="claude-code"
        onSelect={vi.fn()}
        columns={3}
      />
    );
    expect(gridEl(container).style.gridTemplateColumns).toBe('repeat(3, 1fr)');
    expect(gridEl(container).style.gridTemplateColumns).not.toContain('auto-fit');
  });

  it('renders every agent name in full in the small variant (no text BETA pill)', () => {
    render(
      <AgentSelectionGrid
        agents={AVAILABLE_AGENTS}
        selectedAgentId="claude-code"
        onSelect={vi.fn()}
        size="small"
      />
    );
    // All 7 names present verbatim (truncation is CSS-only; nothing is dropped).
    for (const agent of AVAILABLE_AGENTS) {
      expect(screen.getByText(agent.name)).toBeInTheDocument();
    }
    // Beta agents show the icon badge, not a width-eating "BETA" text pill.
    expect(screen.queryByText('BETA')).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Beta').length).toBe(
      AVAILABLE_AGENTS.filter((agent) => agent.beta).length
    );
  });
});
