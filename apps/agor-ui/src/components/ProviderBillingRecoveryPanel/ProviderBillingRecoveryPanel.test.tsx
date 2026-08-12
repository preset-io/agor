import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderBillingRecoveryPanel } from './ProviderBillingRecoveryPanel';

describe('ProviderBillingRecoveryPanel', () => {
  it('renders recovery actions without exposing provider text', () => {
    const onOpenSettings = vi.fn();

    render(
      <ProviderBillingRecoveryPanel tool="claude-code" onOpenAgenticToolSettings={onOpenSettings} />
    );

    expect(screen.getByText(/needs available credit or quota/i)).toBeVisible();
    expect(screen.getByText(/workspace and teammate are still set up/i)).toBeVisible();
    expect(screen.getByText(/send a new message/i)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Open Claude Code settings/i }));
    expect(onOpenSettings).toHaveBeenCalledWith('claude-code');

    const consoleLink = screen.getByRole('link', { name: /Open Claude Code's console/i });
    expect(consoleLink).toHaveAttribute('href', 'https://platform.claude.com/settings/keys');
    expect(screen.queryByText(/credit balance is too low/i)).not.toBeInTheDocument();
  });
});
