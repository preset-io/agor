import type { AgorClient, MCPServer } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showSuccess = vi.fn();
const showInfo = vi.fn();
const showError = vi.fn();
const waitForAttempt = vi.fn();
const refetchState = vi.fn();

vi.mock('@/hooks/usePermissions', () => ({ usePermissions: () => ({ isAdmin: false }) }));
vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({
    showSuccess,
    showInfo,
    showWarning: vi.fn(),
    showError,
  }),
}));
vi.mock('@/utils/mcpOAuthAttempt', () => ({
  oauthAttemptFailureMessage: vi.fn(),
  refreshAndRefetchMCPOAuthGrant: vi.fn(),
  waitForMCPOAuthAttempt: (...args: unknown[]) => waitForAttempt(...args),
  refetchMCPOAuthDurableState: (...args: unknown[]) => refetchState(...args),
}));
vi.mock('./MCPServerEditModal', () => ({ MCPServerEditModal: () => null }));

import { MCPServerPill } from './MCPServerPill';

describe('MCPServerPill OAuth start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts the footer flow through the authenticated OAuth start service without a client ID', async () => {
    const create = vi.fn().mockResolvedValue({
      success: true,
      authorizationUrl: 'https://provider.example/authorize',
      attempt_id: 'attempt-1',
    });
    const client = {
      service: vi.fn().mockReturnValue({ create }),
    } as unknown as AgorClient;
    const server = {
      mcp_server_id: 'server-1',
      name: 'notion',
      display_name: 'Notion',
      url: 'https://mcp.notion.com/mcp',
      transport: 'http',
      auth: { type: 'oauth' },
    } as MCPServer;
    waitForAttempt.mockResolvedValue({ status: 'succeeded' });
    refetchState.mockResolvedValue(undefined);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(<MCPServerPill server={server} needsAuth client={client} />);
    fireEvent.click(screen.getByText('Notion'));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        mcp_server_id: 'server-1',
      })
    );
    expect(open).toHaveBeenCalledWith(
      'https://provider.example/authorize',
      '_blank',
      'noopener,noreferrer'
    );
    await waitFor(() => expect(showSuccess).toHaveBeenCalledWith('Notion authenticated!'));
    expect(showError).not.toHaveBeenCalled();
  });
});
