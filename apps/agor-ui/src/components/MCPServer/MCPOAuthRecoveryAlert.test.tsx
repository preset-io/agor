import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MCPOAuthRecoveryAlert } from './MCPOAuthRecoveryAlert';

describe('MCPOAuthRecoveryAlert', () => {
  it('shows structured DCR recovery and the exact redirect URL without internal stages', () => {
    const onConfigure = vi.fn();
    const onRetry = vi.fn();
    render(
      <MCPOAuthRecoveryAlert
        failure={{
          message: 'The provider could not register an OAuth client automatically.',
          recovery: {
            category: 'client_registration_failed',
            action: 'configure_client',
            message: 'Configure a client.',
          },
          redirectUri: 'https://agor.example.com/mcp-servers/oauth-callback',
        }}
        onConfigure={onConfigure}
        onRetry={onRetry}
      />
    );

    expect(screen.getByText('OAuth setup needs attention')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Configure OAuth client' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.getByText('https://agor.example.com/mcp-servers/oauth-callback')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open OAuth settings' })).not.toBeInTheDocument();
    expect(screen.queryByText(/dcr_registration|HTTP 400/)).not.toBeInTheDocument();
  });

  it('does not recommend manual client settings for unrelated failures', () => {
    render(<MCPOAuthRecoveryAlert failure={{ message: 'The MCP server did not return 401' }} />);

    expect(screen.getByText('OAuth flow could not start')).toBeVisible();
    expect(
      screen.queryByText('https://agor.example.com/mcp-servers/oauth-callback')
    ).not.toBeInTheDocument();
  });

  it('turns compatibility and reauthentication recovery into surface actions', () => {
    const { rerender } = render(
      <MCPOAuthRecoveryAlert
        failure={{
          message: 'Review settings.',
          recovery: {
            category: 'metadata_incompatible',
            action: 'review_compatibility',
            message: 'Review settings.',
          },
        }}
        onConfigure={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Review OAuth settings' })).toBeVisible();

    rerender(
      <MCPOAuthRecoveryAlert
        failure={{
          message: 'Configuration is incomplete.',
          recovery: {
            category: 'configuration_required',
            action: 'review_configuration',
            message: 'Configuration is incomplete.',
          },
        }}
        onConfigure={vi.fn()}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Review OAuth settings' })).toBeVisible();

    rerender(
      <MCPOAuthRecoveryAlert
        failure={{
          message: 'Sign in.',
          recovery: {
            category: 'authentication_required',
            action: 'reauthenticate',
            message: 'Sign in.',
          },
        }}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  });
});
