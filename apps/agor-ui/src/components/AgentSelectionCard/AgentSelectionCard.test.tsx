import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgenticToolOption } from '../../types';
import { AgentSelectionCard } from './AgentSelectionCard';

const betaAgent: AgenticToolOption = {
  id: 'cursor',
  name: 'Cursor SDK',
  icon: '⌘',
  description: 'Cursor agentic runtime',
  beta: true,
};

describe('AgentSelectionCard beta badge', () => {
  it('uses a focusable button with accessible selection state', () => {
    const onClick = vi.fn();
    const { container } = render(
      <AgentSelectionCard agent={betaAgent} selected onClick={onClick} size="small" />
    );

    const button = container.querySelector('[role="button"]') as HTMLElement;
    expect(button).toHaveAttribute('aria-label', 'Cursor SDK');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAttribute('tabindex', '0');
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('small variant: icon-only beta badge (no "BETA" text), full name visible', () => {
    render(<AgentSelectionCard agent={betaAgent} size="small" />);
    // Full name is rendered (never replaced by a text pill that eats width).
    expect(screen.getByText('Cursor SDK')).toBeInTheDocument();
    // Beta is an accessible icon, not a "BETA" text tag.
    expect(screen.getByLabelText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('BETA')).not.toBeInTheDocument();
  });

  it('small variant: no beta badge for non-beta agents', () => {
    render(<AgentSelectionCard agent={{ ...betaAgent, beta: false }} size="small" />);
    expect(screen.queryByLabelText('Beta')).not.toBeInTheDocument();
  });

  it('default variant keeps the "BETA" text tag (unchanged)', () => {
    render(<AgentSelectionCard agent={betaAgent} />);
    expect(screen.getByText('BETA')).toBeInTheDocument();
  });

  it('suppresses the card tooltip while the beta icon is hovered', {
    timeout: 10_000,
  }, async () => {
    render(<AgentSelectionCard agent={betaAgent} size="small" />);
    const card = screen.getByText('Cursor SDK').closest('.ant-card') as HTMLElement;

    // Hovering the tile body shows the general description tooltip.
    fireEvent.mouseEnter(card);
    expect(await screen.findByText('Cursor agentic runtime')).toBeInTheDocument();

    // Hovering the beta icon suppresses the general tooltip (no stacking): the
    // card tooltip is driven to open=false, so antd marks it hidden.
    const generalTip = screen.getByText('Cursor agentic runtime').closest('.ant-tooltip');
    fireEvent.mouseEnter(screen.getByLabelText('Beta').parentElement as HTMLElement);
    await waitFor(() => expect(generalTip).toHaveClass('ant-tooltip-hidden'));
  });
});
