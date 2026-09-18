import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DaemonConfigurationAlert, DaemonConnectionAlert } from './DaemonErrorAlerts';

describe('daemon error alerts', () => {
  it('renders a single accessible connection failure without deployment instructions', () => {
    render(<DaemonConnectionAlert message="Failed to connect to Agor daemon" />);

    expect(screen.getByRole('alert')).toHaveTextContent(/^Failed to connect to Agor daemon$/);
    expect(screen.getAllByText('Failed to connect to Agor daemon')).toHaveLength(1);
    expect(screen.getByRole('alert')).not.toHaveTextContent(/3030|pnpm dev|cd apps/);
  });

  it('preserves the actionable authentication failure', () => {
    render(
      <DaemonConnectionAlert message="Authentication could not be restored. Please sign in again." />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Please sign in again.');
  });

  it.each([false, true])('keeps configuration retry (unsupported contract: %s)', (unsupported) => {
    const onRetry = vi.fn();
    render(
      <DaemonConfigurationAlert unsupportedIdentityContract={unsupported} onRetry={onRetry} />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      unsupported
        ? 'Incompatible daemon configuration contract'
        : 'Could not fetch daemon configuration'
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      unsupported
        ? 'Deploy compatible Agor UI and daemon versions, then retry.'
        : 'Please try again.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/3030|pnpm dev|cd apps/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
