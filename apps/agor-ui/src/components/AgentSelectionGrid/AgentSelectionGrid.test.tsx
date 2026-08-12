/**
 * The dense (small) tile grid must be overflow-proof: it uses auto-fit tracks
 * so tiles wrap within the container instead of escaping it, while the default
 * variant keeps its fixed-column layout unchanged.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgenticToolOption } from '../../types';
import { AgentSelectionGrid } from './AgentSelectionGrid';
import { AVAILABLE_AGENTS } from './availableAgents';

const store = vi.hoisted(() => ({ agenticToolSettingsByName: new Map() }));

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({ agenticToolSettingsByName: store.agenticToolSettingsByName }),
}));

const agents: AgenticToolOption[] = [
  { id: 'claude-code', name: 'Claude Code', icon: '🤖', description: 'x' },
  { id: 'opencode', name: 'OpenCode', icon: '🌐', description: 'y' },
];

afterEach(() => {
  store.agenticToolSettingsByName = new Map();
});

function gridEl(container: HTMLElement): HTMLElement {
  return container.querySelector('[style*="grid"]') as HTMLElement;
}

describe('AgentSelectionGrid tile layout', () => {
  it('shows a non-operator action when no deployment/workspace tool is available', () => {
    store.agenticToolSettingsByName = new Map(
      agents.map((agent) => [agent.id, { tool: agent.id, enabled: false }])
    );
    render(<AgentSelectionGrid agents={agents} selectedAgentId={null} onSelect={vi.fn()} />);
    expect(screen.getByText('No agentic tools are enabled for this workspace')).toBeInTheDocument();
    expect(
      screen.getByText(/Deployment package changes require a separate deployment operator/)
    ).toBeInTheDocument();
  });

  it('does not replace an unavailable persisted selection unless fallback is opted in', () => {
    const onSelect = vi.fn();
    render(
      <AgentSelectionGrid agents={agents} selectedAgentId="claude-code-cli" onSelect={onSelect} />
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('allows creation flows to opt into the first visible fallback', async () => {
    const onSelect = vi.fn();
    render(
      <AgentSelectionGrid
        agents={agents}
        selectedAgentId="claude-code-cli"
        onSelect={onSelect}
        fallbackToFirstVisibleAgent
      />
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('claude-code'));
  });

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
    expect(AVAILABLE_AGENTS.find((agent) => agent.id === 'opencode')?.beta).not.toBe(true);

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
