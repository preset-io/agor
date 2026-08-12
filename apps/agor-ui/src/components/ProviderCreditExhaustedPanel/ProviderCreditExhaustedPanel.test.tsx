import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ProviderCreditExhaustedPanel } from './ProviderCreditExhaustedPanel';

describe('ProviderCreditExhaustedPanel', () => {
  it('explains the provider recovery path and keeps the existing setup intact', () => {
    const onOpenSettings = vi.fn();

    render(
      <AntApp>
        <ProviderCreditExhaustedPanel
          tool="claude-code"
          onOpenAgenticToolSettings={onOpenSettings}
        />
      </AntApp>
    );

    expect(screen.getByText(/no available balance or usage quota/i)).toBeInTheDocument();
    expect(screen.getByText(/AI teammate and workspace are still set up/i)).toBeInTheDocument();
    expect(screen.getByText(/send a new message/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open Claude Code settings/i }));
    expect(onOpenSettings).toHaveBeenCalledWith('claude-code');
    expect(screen.getByRole('link', { name: /open Claude Code account/i })).toHaveAttribute(
      'href',
      'https://platform.claude.com/settings/keys'
    );
  });
});
