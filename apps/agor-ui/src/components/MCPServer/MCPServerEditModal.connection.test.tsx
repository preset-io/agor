import type { MCPDiscoveryResult } from '@agor/core/types';
import type { AgorClient, MCPServer } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPServerEditModal } from './MCPServerEditModal';

const showError = vi.fn();
vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({
    showSuccess: vi.fn(),
    showError,
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));
const result: MCPDiscoveryResult = {
  success: true,
  capabilities: { tools: 1, resources: 0, prompts: 0 },
  metadata: { descriptions_truncated: 1 },
  tools: [{ name: 'search', description: 'Bounded description' }],
  resources: [],
  prompts: [],
};
function harness(
  options: { discover?: ReturnType<typeof vi.fn>; patch?: ReturnType<typeof vi.fn> } = {}
) {
  const server = {
    mcp_server_id: '01900000-0000-7000-8000-000000000001' as MCPServer['mcp_server_id'],
    name: 'fictional',
    source: 'user',
    created_at: new Date(),
    updated_at: new Date(),
    transport: 'http',
    url: 'https://before.example/mcp',
    scope: 'global',
    enabled: true,
    config_version: 7,
    auth: { type: 'bearer', token: '••••••••' },
    headers: { 'X-Key': '••••••••' },
    env: { API_KEY: '••••••••' },
  } as MCPServer;
  const discover = options.discover ?? vi.fn().mockResolvedValue(result);
  const patch = options.patch ?? vi.fn().mockResolvedValue({ ...server, config_version: 8 });
  const client = {
    service: vi.fn((path: string) => {
      if (path === 'mcp-servers/discover') return { create: discover };
      if (path === 'mcp-servers/oauth-browser-reservations')
        return {
          create: vi.fn().mockResolvedValue({
            reservation_token: 'fictional-reservation-token-00001',
            expires_at: Date.now() + 60_000,
          }),
        };
      return { get: vi.fn().mockResolvedValue(server), patch };
    }),
    io: { on: vi.fn(), off: vi.fn() },
  } as unknown as AgorClient;
  render(
    <MCPServerEditModal
      server={server}
      open
      client={client}
      identityKey="user-a"
      authorityKey="user-a:admin:1"
      authGeneration={1}
      mutationAllowed
      onClose={vi.fn()}
    />
  );
  return { server, discover, patch };
}
const button = (label: string) => {
  const element = screen.getByText(label).closest('button');
  if (!element) throw new Error(`Button not found: ${label}`);
  return element;
};
describe('saved MCP form connection flow', () => {
  beforeEach(() => vi.clearAllMocks());
  it('saves the visible draft and preserved secrets before discovery, then shows its metadata', async () => {
    const h = harness();
    fireEvent.change(await screen.findByLabelText('URL'), {
      target: { value: 'https://after.example/mcp' },
    });
    fireEvent.click(button('Save & Test Connection'));
    await screen.findByText('Connected: 1 tools, 0 resources, 0 prompts');
    expect(h.patch).toHaveBeenCalledWith(
      h.server.mcp_server_id,
      expect.objectContaining({
        expected_config_version: 7,
        url: 'https://after.example/mcp',
        auth: { type: 'bearer', token: '••••••••' },
      })
    );
    expect(h.patch.mock.invocationCallOrder[0]).toBeLessThan(
      h.discover.mock.invocationCallOrder[0]
    );
    expect(h.discover).toHaveBeenCalledWith({
      mcp_server_id: h.server.mcp_server_id,
      oauth_browser_event: { reservation_token: 'fictional-reservation-token-00001' },
    });
    expect(
      screen.getByText("1 provider description(s) shortened to Agor's safe metadata budget")
    ).toBeInTheDocument();
    expect(screen.queryByText('Test Authentication')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://next.example/mcp' },
    });
    expect(
      screen.queryByText('Connected: 1 tools, 0 resources, 0 prompts')
    ).not.toBeInTheDocument();
  });
  it('does not probe after a save conflict', async () => {
    const h = harness({ patch: vi.fn().mockRejectedValue({ code: 409 }) });
    fireEvent.click(button('Save & Test Connection'));
    await screen.findByText('Newer MCP settings are available');
    expect(h.discover).not.toHaveBeenCalled();
    expect(button('Save')).toBeDisabled();
    expect(button('Save & Test Connection')).toBeDisabled();
  });
  it('does not display an old draft result after editing during discovery', async () => {
    let resolve!: (value: MCPDiscoveryResult) => void;
    const h = harness({
      discover: vi.fn(
        () =>
          new Promise<MCPDiscoveryResult>((done) => {
            resolve = done;
          })
      ),
    });
    fireEvent.click(button('Save & Test Connection'));
    await waitFor(() => expect(h.discover).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://next.example/mcp' },
    });
    await act(async () => resolve(result));
    expect(
      screen.queryByText('Connected: 1 tools, 0 resources, 0 prompts')
    ).not.toBeInTheDocument();
    expect(button('Save & Test Connection')).toBeEnabled();
  });
  it('validates environment JSON and explicitly clears emptied secret maps', async () => {
    const h = harness();
    fireEvent.change(await screen.findByLabelText('Environment Variables'), {
      target: { value: '{invalid' },
    });
    fireEvent.click(button('Save'));
    await screen.findByText('Environment variables must be valid JSON');
    expect(h.patch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Environment Variables'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Custom HTTP Headers'), { target: { value: '' } });
    fireEvent.click(button('Save'));
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith(
        h.server.mcp_server_id,
        expect.objectContaining({ env: {}, headers: {} })
      )
    );
  });
});
