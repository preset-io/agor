import type { AgorClient, MCPServer } from '@agor-live/client';
import { act, cleanup, render, screen } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { MCPServerEditModal } from './MCPServerEditModal';

afterEach(cleanup);
it('can edit, save, discover, inspect the notice, and save again at every viewport', async () => {
  const server = {
    mcp_server_id: '01900000-0000-7000-8000-000000000001',
    name: 'fictional',
    transport: 'http',
    url: 'https://before.example/mcp',
    scope: 'global',
    enabled: true,
    config_version: 7,
    auth: { type: 'none' },
  } as MCPServer;
  const patch = vi.fn().mockResolvedValue({ ...server, config_version: 8 });
  const discover = vi.fn().mockResolvedValue({
    success: true,
    capabilities: { tools: 1, resources: 0, prompts: 0 },
    metadata: { descriptions_truncated: 1 },
    tools: [{ name: 'search', description: 'Bounded description' }],
    resources: [],
    prompts: [],
  });
  const client = {
    service: (path: string) => {
      if (path === 'mcp-servers/discover') return { create: discover };
      if (path === 'mcp-servers/oauth-browser-reservations')
        return {
          create: vi.fn().mockResolvedValue({
            reservation_token: 'fictional-browser-reservation',
            expires_at: Date.now() + 60_000,
          }),
        };
      return { patch };
    },
    io: { on: vi.fn(), off: vi.fn() },
  } as unknown as AgorClient;
  const close = vi.fn();
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <App>
        <MCPServerEditModal
          server={server}
          open
          client={client}
          identityKey="user-a"
          authorityKey="user-a:admin:1"
          authGeneration={1}
          mutationAllowed
          onClose={close}
        />
      </App>
    </ConfigProvider>
  );
  const url = await screen.findByLabelText('URL');
  await act(() => userEvent.fill(url, 'https://after.example/mcp'));
  await act(() => userEvent.click(screen.getByRole('button', { name: /Save & Test Connection/ })));
  const notice = await screen.findByText(
    "1 provider description(s) shortened to Agor's safe metadata budget"
  );
  notice.scrollIntoView();
  expect(notice).toBeVisible();
  expect(patch.mock.calls[0]?.[1]).toMatchObject({
    url: 'https://after.example/mcp',
    expected_config_version: 7,
  });
  expect(discover).toHaveBeenCalledOnce();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  await act(() => userEvent.fill(url, 'https://final.example/mcp'));
  expect(screen.queryByText('Connected: 1 tools, 0 resources, 0 prompts')).not.toBeInTheDocument();
  await act(() => userEvent.click(screen.getByRole('button', { name: 'Save' })));
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(patch.mock.calls[1]?.[1]).toMatchObject({
    url: 'https://final.example/mcp',
    expected_config_version: 8,
  });
});
