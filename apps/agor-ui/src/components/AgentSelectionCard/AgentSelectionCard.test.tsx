import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgenticToolOption } from '../../types';
import { AgentSelectionCard } from './AgentSelectionCard';

const betaAgent: AgenticToolOption = {
  id: 'opencode',
  name: 'OpenCode',
  icon: '🌐',
  description: 'Open-source terminal AI',
  beta: true,
};

describe('AgentSelectionCard beta badge', () => {
  it('small variant: icon-only beta badge (no "BETA" text), full name visible', () => {
    render(<AgentSelectionCard agent={betaAgent} size="small" />);
    // Full name is rendered (never replaced by a text pill that eats width).
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
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
});
