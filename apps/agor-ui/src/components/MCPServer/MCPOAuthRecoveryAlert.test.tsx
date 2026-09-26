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

  it('shows the closed reason with the authoritative failure policy, without triggering recovery', () => {
    const onRetry = vi.fn();
    const onConfigure = vi.fn();
    const { container } = render(
      <MCPOAuthRecoveryAlert
        failure={{
          message: 'Dynamic Client Registration is explicitly disabled.',
          recovery: {
            category: 'client_registration_required',
            action: 'configure_client',
            message: 'Dynamic Client Registration is explicitly disabled.',
            failure_reason: 'dcr_disabled',
            oauth_policy: {
              effective_mode: 'strict',
              effective_dcr_mode: 'disabled',
              dcr_mode_source: 'explicit',
            },
          },
        }}
        onRetry={onRetry}
        onConfigure={onConfigure}
      />
    );
    expect(screen.getByText('dcr_disabled')).toBeVisible();
    expect(container).toHaveTextContent(
      'Policy at failure: compatibility strict; DCR disabled (explicit).'
    );
    expect(onRetry).not.toHaveBeenCalled();
    expect(onConfigure).not.toHaveBeenCalled();
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
