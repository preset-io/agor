import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MCPOAuthRecoveryAlert } from './MCPOAuthRecoveryAlert';

describe('MCPOAuthRecoveryAlert', () => {
  it('shows DCR recovery, safe diagnostics, and the exact redirect URL', () => {
    const onOpenSettings = vi.fn();
    render(
      <MCPOAuthRecoveryAlert
        failure={{
          message: 'Dynamic Client Registration failed',
          diagnostic: {
            stage: 'dcr_registration',
            http_status: 400,
          },
          redirectUri: 'https://agor.example.com/mcp-servers/oauth-callback',
        }}
        onOpenSettings={onOpenSettings}
      />
    );

    expect(screen.getByText('OAuth setup needs attention')).toBeVisible();
    expect(screen.getByText(/HTTP 400/)).toBeVisible();
    expect(screen.getByText('https://agor.example.com/mcp-servers/oauth-callback')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open OAuth settings' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('does not recommend manual client settings for unrelated failures', () => {
    render(
      <MCPOAuthRecoveryAlert
        failure={{ message: 'The MCP server did not return 401' }}
        onOpenSettings={vi.fn()}
      />
    );

    expect(screen.getByText('OAuth flow could not start')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open OAuth settings' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('https://agor.example.com/mcp-servers/oauth-callback')
    ).not.toBeInTheDocument();
  });
});
