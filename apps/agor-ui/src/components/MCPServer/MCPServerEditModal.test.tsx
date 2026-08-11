import type { AgorClient, MCPServer } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showSuccess = vi.fn();
const showError = vi.fn();

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({
    showSuccess,
    showError,
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

import { MCPServerEditModal } from './MCPServerEditModal';

describe('MCPServerEditModal legacy DCR compatibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps oauth_dcr_mode absent when an unrelated field is saved', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = {
      service: vi.fn().mockReturnValue({ patch }),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000001',
      name: 'legacy-notion',
      display_name: 'Legacy Notion',
      description: 'before',
      transport: 'http',
      url: 'https://mcp.notion.com/mcp',
      scope: 'global',
      enabled: true,
      auth: { type: 'oauth' },
    } as MCPServer;

    render(<MCPServerEditModal server={server} open client={client} onClose={vi.fn()} />);

    const description = await screen.findByLabelText('Description');
    fireEvent.change(description, { target: { value: 'after' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const updates = patch.mock.calls[0]?.[1] as { auth?: Record<string, unknown> };
    expect(updates.auth).not.toHaveProperty('oauth_dcr_mode');
    expect(showSuccess).toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});
