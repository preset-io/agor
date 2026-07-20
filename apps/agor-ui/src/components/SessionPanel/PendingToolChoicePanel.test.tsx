import { fireEvent, render, screen } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AgenticToolOption } from '../AgentSelectionGrid/AgentSelectionGrid';
import { PendingToolChoicePanel } from './PendingToolChoicePanel';

const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <ConfigProvider>
    <App>{children}</App>
  </ConfigProvider>
);

const agents: AgenticToolOption[] = [
  { id: 'claude-code', name: 'Claude Code', icon: '🤖', description: 'Anthropic' },
  { id: 'codex', name: 'Codex', icon: '💻', description: 'OpenAI' },
];

describe('PendingToolChoicePanel', () => {
  it('renders one tile per available agent and the inert composer bar', () => {
    render(
      <Wrapper>
        <PendingToolChoicePanel
          open
          branch={null}
          availableAgents={agents}
          onChoose={vi.fn()}
          onClose={vi.fn()}
        />
      </Wrapper>
    );

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Untitled session')).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText('Pick a tool above to start typing…');
    expect(textarea).toHaveAttribute('disabled');
    expect(screen.getByText('Options').closest('button')).toHaveAttribute('disabled');
    expect(screen.getByText('Send').closest('button')).toHaveAttribute('disabled');
  });

  it('calls onChoose with the tool id when a tile is clicked', () => {
    const onChoose = vi.fn();
    render(
      <Wrapper>
        <PendingToolChoicePanel
          open
          branch={null}
          availableAgents={agents}
          onChoose={onChoose}
          onClose={vi.fn()}
        />
      </Wrapper>
    );

    fireEvent.click(screen.getByText('Codex'));
    expect(onChoose).toHaveBeenCalledWith('codex');
  });

  it('only shows the advanced-setup escape hatch when a handler is provided', () => {
    const { rerender } = render(
      <Wrapper>
        <PendingToolChoicePanel
          open
          branch={null}
          availableAgents={agents}
          onChoose={vi.fn()}
          onClose={vi.fn()}
        />
      </Wrapper>
    );
    expect(screen.queryByText(/advanced setup/i)).not.toBeInTheDocument();

    const onAdvancedSetup = vi.fn();
    rerender(
      <Wrapper>
        <PendingToolChoicePanel
          open
          branch={null}
          availableAgents={agents}
          onChoose={vi.fn()}
          onClose={vi.fn()}
          onAdvancedSetup={onAdvancedSetup}
        />
      </Wrapper>
    );
    fireEvent.click(screen.getByText(/advanced setup/i));
    expect(onAdvancedSetup).toHaveBeenCalled();
  });
});
