import type { AgorClient } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './components/LoginPage';
import { MCPOAuthReturnPage } from './pages/MCPOAuthReturnPage';
import { captureMcpOAuthReturn } from './utils/mcpOAuthReturn';

/**
 * The App composition a signed-out provider return goes through: `main.tsx`
 * captures the response at boot, App's auth gate then renders `LoginPage`
 * (whose external-launch link copies the current address into `return_to`),
 * and after sign-in the return route renders `MCPOAuthReturnPage`.
 */
describe('signed-out MCP OAuth return', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/ui/');
    window.sessionStorage.clear();
  });

  it('keeps code and state out of the address and return_to, then finishes after sign-in', async () => {
    window.history.replaceState(
      {},
      '',
      '/ui/connect/mcp/return#state=state-signed-out&code=code-signed-out&iss=https%3A%2F%2Fprovider.example'
    );
    captureMcpOAuthReturn();
    expect(window.location.href).not.toMatch(/state-signed-out|code-signed-out/);

    const login = render(
      <LoginPage
        onLogin={vi.fn()}
        externalLaunchLoginRedirectUrl="https://cloud.example/launch-init"
        externalLaunchReturnHostParam="return_host"
      />
    );
    const href = screen.getByRole('link', { name: 'Return to workspace' }).getAttribute('href')!;
    expect(new URL(href).searchParams.get('return_to')).toBe('/ui/connect/mcp/return');
    expect(href).not.toMatch(/state-signed-out|code-signed-out|%23|#/);
    login.unmount();

    // The launch round trip lands back on `return_to`, without a fragment.
    window.history.replaceState({}, '', '/ui/connect/mcp/return');
    captureMcpOAuthReturn();
    const create = vi.fn(async () => ({ success: true }));
    const client = { service: vi.fn(() => ({ create })) } as unknown as AgorClient;
    render(<MCPOAuthReturnPage client={client} />);

    expect(await screen.findByText('Connected')).toBeVisible();
    expect(client.service).toHaveBeenCalledWith('mcp-servers/oauth-complete');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      state: 'state-signed-out',
      code: 'code-signed-out',
      iss: 'https://provider.example',
    });
    expect(window.sessionStorage.length).toBe(0);
  });
});
