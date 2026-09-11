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

it.each(['dcr_disabled', 'protected_resource_mismatch'] as const)(
  'inspects saved policy without side effects and renders %s',
  async (failureReason) => {
    const server = {
      mcp_server_id: '01900000-0000-7000-8000-000000000002',
      name: 'OAuth diagnostics fixture',
      transport: 'http',
      url: 'https://fixture.example/mcp',
      scope: 'global',
      enabled: true,
      config_version: 1,
      source: 'user',
      auth: { type: 'oauth', oauth_compatibility_mode: 'strict', oauth_dcr_mode: 'disabled' },
      oauth_compatibility_policy: {
        effective_mode: 'strict',
        managed_by_catalog: false,
        effective_dcr_mode: 'disabled',
        dcr_mode_source: 'explicit',
      },
    } as MCPServer;
    const patch = vi.fn().mockResolvedValue({
      ...server,
      config_version: 2,
      oauth_compatibility_policy: undefined,
    });
    const get = vi.fn().mockResolvedValue({ ...server, config_version: 2 });
    const failureMessage =
      failureReason === 'dcr_disabled'
        ? 'Dynamic Client Registration is explicitly disabled. Save a pre-registered Client ID.'
        : 'The protected-resource metadata does not match the saved MCP resource URL. Verify the MCP URL and provider resource metadata.';
    const start = vi.fn().mockResolvedValue({
      success: false,
      error: failureMessage,
      recovery: {
        category:
          failureReason === 'dcr_disabled'
            ? 'client_registration_required'
            : 'metadata_incompatible',
        action: failureReason === 'dcr_disabled' ? 'configure_client' : 'review_compatibility',
        message: failureMessage,
        failure_reason: failureReason,
        oauth_policy: {
          effective_mode: 'strict',
          effective_dcr_mode: 'disabled',
          dcr_mode_source: 'explicit',
        },
      },
    });
    const service = vi.fn((path: string) => {
      if (path === 'mcp-servers') return { patch, get };
      if (path === 'mcp-servers/oauth-start') return { create: start };
      throw new Error(`Unexpected inspection side effect: ${path}`);
    });
    const client = { service, io: { on: vi.fn(), off: vi.fn() } } as unknown as AgorClient;
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
            onClose={vi.fn()}
          />
        </App>
      </ConfigProvider>
    );
    const summary = await screen.findByText(/Saved OAuth policy:/);
    expect(summary).toHaveTextContent('compatibility strict; DCR disabled (explicit).');
    expect(service).not.toHaveBeenCalled();
    await act(() => userEvent.click(screen.getByRole('button', { name: /Start OAuth Flow/ })));
    const reason = await screen.findByText(failureReason);
    reason.scrollIntoView();
    expect(reason).toBeVisible();
    expect(screen.getByText(/Policy at failure:/)).toHaveTextContent(
      'compatibility strict; DCR disabled (explicit).'
    );
    expect(patch.mock.calls[0]?.[1]?.auth).toMatchObject({
      oauth_dcr_mode: 'disabled',
      oauth_compatibility_mode: 'strict',
    });
    expect(start).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(screen.getByText(/Saved OAuth policy:/)).toHaveTextContent(
      'compatibility strict; DCR disabled (explicit).'
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  }
);

it('reloads saved policy after Save & Test and projection-less realtime without replacing the draft', async () => {
  const server = {
    mcp_server_id: '01900000-0000-7000-8000-000000000003',
    name: 'OAuth save-test fixture',
    transport: 'http',
    url: 'https://fixture.example/mcp',
    scope: 'global',
    enabled: true,
    config_version: 1,
    auth: { type: 'oauth', oauth_grant_type: 'authorization_code' },
    oauth_compatibility_policy: {
      effective_mode: 'strict',
      managed_by_catalog: false,
      effective_dcr_mode: 'advertised',
      dcr_mode_source: 'default',
    },
  } as MCPServer;
  const saved = {
    ...server,
    config_version: 2,
    auth: { ...server.auth, oauth_dcr_mode: 'disabled' },
    oauth_compatibility_policy: undefined,
  } as MCPServer;
  const get = vi.fn().mockResolvedValue({
    ...saved,
    oauth_compatibility_policy: {
      ...server.oauth_compatibility_policy,
      effective_dcr_mode: 'disabled',
      dcr_mode_source: 'explicit',
    },
  });
  const patch = vi.fn().mockResolvedValue(saved);
  const discover = vi.fn().mockResolvedValue({
    success: true,
    capabilities: { tools: 1, resources: 0, prompts: 0 },
  });
  const reserve = vi.fn().mockResolvedValue({
    reservation_token: 'browser-policy-read-reservation-000001',
    expires_at: Date.now() + 60_000,
  });
  const client = {
    service: (path: string) => {
      if (path === 'mcp-servers') return { patch, get };
      if (path === 'mcp-servers/discover') return { create: discover };
      if (path === 'mcp-servers/oauth-browser-reservations') return { create: reserve };
      throw new Error(`Unexpected service: ${path}`);
    },
    io: { on: vi.fn(), off: vi.fn() },
  } as unknown as AgorClient;
  const view = (row: MCPServer) => (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <App>
        <MCPServerEditModal
          server={row}
          open
          client={client}
          identityKey="user-a"
          authorityKey="user-a:admin:1"
          authGeneration={1}
          mutationAllowed
          onClose={vi.fn()}
        />
      </App>
    </ConfigProvider>
  );
  const rendered = render(view(server));
  expect(await screen.findByText(/Saved OAuth policy:/)).toHaveTextContent(
    'DCR advertised (default)'
  );
  await act(() => userEvent.click(screen.getByText('Advanced — OAuth settings')));
  await act(() => userEvent.click(screen.getByLabelText('Dynamic Client Registration')));
  await act(() => userEvent.click(screen.getByText('Disabled — pre-registered client')));
  // An unsaved field is not evidence of saved policy.
  expect(screen.getByText(/Saved OAuth policy:/)).toHaveTextContent('DCR advertised (default)');
  await act(() => userEvent.click(screen.getByRole('button', { name: /Save & Test Connection/ })));
  await screen.findByText('Connected: 1 tools, 0 resources, 0 prompts');
  expect(screen.getByText(/Saved OAuth policy:/)).toHaveTextContent('DCR disabled (explicit)');
  expect(patch.mock.calls[0]?.[1]?.auth.oauth_dcr_mode).toBe('disabled');
  expect(get).toHaveBeenCalledOnce();
  expect(discover).toHaveBeenCalledOnce();

  await act(() => userEvent.fill(screen.getByLabelText('URL'), 'https://unsaved.example/mcp'));
  const realtime = { ...saved, config_version: 3, auth: server.auth };
  get.mockResolvedValueOnce({
    ...realtime,
    oauth_compatibility_policy: server.oauth_compatibility_policy,
  });
  rendered.rerender(view(realtime));
  await vi.waitFor(() =>
    expect(screen.getByText(/Saved OAuth policy:/)).toHaveTextContent('DCR advertised (default)')
  );
  expect(screen.getByLabelText('URL')).toHaveValue('https://unsaved.example/mcp');
  expect(get).toHaveBeenCalledTimes(2);
  expect(patch).toHaveBeenCalledOnce();
  expect(discover).toHaveBeenCalledOnce();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
});
