import type { AgorClient } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPOAuthReturnPage } from './MCPOAuthReturnPage';

function client(result: unknown): { agor: AgorClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => result);
  const agor = { service: vi.fn(() => ({ create })) } as unknown as AgorClient;
  return { agor, create };
}

afterEach(() => {
  window.history.replaceState({}, '', '/ui/');
});

describe('MCP OAuth return surface', () => {
  it('finishes the sign-in once with the signed-in session and clears the fragment', async () => {
    window.history.replaceState(
      {},
      '',
      '/ui/connect/mcp/return#state=state-1&code=code-1&iss=https%3A%2F%2Fprovider.example'
    );
    const { agor, create } = client({ success: true });
    render(
      <StrictMode>
        <MCPOAuthReturnPage client={agor} />
      </StrictMode>
    );

    expect(await screen.findByText('Connected')).toBeVisible();
    expect(window.location.hash).toBe('');
    expect(agor.service).toHaveBeenCalledWith('mcp-servers/oauth-complete');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      state: 'state-1',
      code: 'code-1',
      iss: 'https://provider.example',
    });
  });

  it('forwards a provider denial and shows the daemon refusal', async () => {
    window.history.replaceState({}, '', '/ui/connect/mcp/return#state=state-2&error=access_denied');
    const { agor, create } = client({
      success: false,
      error: 'OAuth flow belongs to a different user. Please restart the OAuth flow.',
    });
    render(<MCPOAuthReturnPage client={agor} />);

    expect(await screen.findByText(/belongs to a different user/)).toBeVisible();
    expect(create).toHaveBeenCalledWith({ state: 'state-2', error: 'access_denied' });
  });

  it('submits nothing without a complete provider response', async () => {
    window.history.replaceState({}, '', '/ui/connect/mcp/return#state=state-3');
    const { agor, create } = client({ success: true });
    render(<MCPOAuthReturnPage client={agor} />);

    expect(await screen.findByText('Nothing to finish here')).toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });
});
