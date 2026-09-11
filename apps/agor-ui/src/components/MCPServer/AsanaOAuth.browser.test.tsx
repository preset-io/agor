import type { MCPMarketplaceOverview, MCPOAuthAttemptResult } from '@agor/core/types';
import type { AgorClient, MCPServer, UpdateMCPServerInput } from '@agor-live/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, message } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { agorStore } from '../../store/agorStore';
import { checkBrowserSanity } from '../../test/browserSanity';
import {
  catalogOverview,
  catalogUser,
  makeCatalogClient,
} from '../Marketplace/MCPCatalogModal.test-fixtures';
import { MyServersTab } from '../Marketplace/MyServersTab';
import { MCPServerEditModal } from './MCPServerEditModal';

// API/window boundaries only: the editor, inventory, hooks and polling are real.
// No request or popup ever reaches Asana. Catalog transport streamable-http maps
// to the saved-server transport http; backend OAuth/tenant enforcement is not mocked proof.
checkBrowserSanity();
const server = {
  mcp_server_id: '01900000-0000-7000-8000-000000000001',
  name: 'asana',
  display_name: 'Asana',
  source: 'catalog',
  catalog_entry_name: 'com.asana/mcp',
  transport: 'http',
  url: 'https://mcp.asana.com/v2/mcp',
  scope: 'session',
  owner_user_id: catalogUser.user_id,
  enabled: true,
  config_version: 7,
  auth: {
    type: 'oauth',
    oauth_mode: 'per_user',
    oauth_dcr_mode: 'disabled',
    oauth_client_id: 'synthetic-asana-app',
    oauth_client_secret: '••••••••',
  },
} as MCPServer;
const authorizationUrl = 'https://oauth.example.test/authorize?state=synthetic';
const overview: MCPMarketplaceOverview = {
  ...catalogOverview,
  attachments: [],
  servers: [
    {
      ...catalogOverview.servers[0],
      mcp_server_id: server.mcp_server_id,
      name: 'asana',
      display_name: 'Asana',
      session_count: 0,
    },
  ],
  credentials: [
    {
      ...catalogOverview.credentials[0],
      mcp_server_id: server.mcp_server_id,
      server_name: 'asana',
      server_display_name: 'Asana',
      status: 'attention',
      detail_status: 'not_connected',
    },
  ],
};
function Shell({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}
function api() {
  const base = makeCatalogClient();
  let attempt: MCPOAuthAttemptResult = { status: 'pending' };
  const patch = vi.fn(async (_id: string, _data: UpdateMCPServerInput) => ({
    ...server,
    config_version: 8,
  }));
  const start = vi.fn(
    async (): Promise<unknown> => ({
      success: true,
      authorizationUrl,
      attempt_id: 'synthetic-attempt',
    })
  );
  const poll = vi.fn(async () => attempt);
  const status = vi.fn(async () => ({ authenticated_server_ids: [server.mcp_server_id] }));
  const get = vi.fn(async () => server);
  const client = {
    ...base.client,
    service: (path: string) => {
      if (path === 'mcp-servers') return { ...base.client.service(path), patch, get };
      if (path === 'mcp-servers/oauth-start') return { create: start };
      if (path === 'mcp-servers/oauth-attempt-status') return { get: poll };
      if (path === 'mcp-servers/oauth-status') return { find: status };
      return base.client.service(path as 'mcp-servers');
    },
  } as unknown as AgorClient;
  return {
    client,
    patch,
    start,
    poll,
    status,
    get,
    complete: (value: MCPOAuthAttemptResult) => {
      attempt = value;
    },
  };
}
function editor(h: ReturnType<typeof api>, identityKey = catalogUser.user_id) {
  return (
    <MCPServerEditModal
      server={server}
      open
      client={h.client}
      identityKey={identityKey}
      authorityKey={`${identityKey}:member:1`}
      authGeneration={1}
      mutationAllowed
      onClose={vi.fn()}
    />
  );
}
async function advanced() {
  await userEvent.click(await screen.findByText('Advanced — OAuth settings'));
  return screen.findByLabelText('Client Secret');
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  // Static message creates a separate React root, outside Shell. Disable its
  // presentation motion too: hosted Chromium can otherwise leave destroy()
  // waiting indefinitely for a CSS animationend from an unmounted test tree.
  ConfigProvider.config({
    holderRender: (children) => (
      <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
    ),
  });
  agorStore.getState().reset();
  vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(async () => {
  try {
    cleanup();
    message.destroy();
    // Assert real portal removal, not merely an API call or hidden animation.
    // Pending/identity negatives below still observe the actual notifications.
    await waitFor(() => expect(document.querySelector('.ant-message-notice')).toBeNull());
  } finally {
    // A teardown failure must not leak popup history or global presentation
    // settings into another test and produce misleading OAuth failures.
    agorStore.getState().reset();
    vi.restoreAllMocks();
    ConfigProvider.config({ holderRender: undefined });
  }
});

describe('Asana V2 saved OAuth in real Chromium', () => {
  it('lets an ordinary authorized member sign in from server settings without configuring again', async () => {
    const h = api();
    const refresh = vi.fn(async () => undefined);
    render(
      <MyServersTab
        client={h.client}
        currentUser={catalogUser}
        connected
        connecting={false}
        authGeneration={1}
        overview={overview}
        loading={false}
        error={null}
        refresh={refresh}
      />,
      { wrapper: Shell }
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Settings for Asana' }));
    // The inventory names normal Sign in "Connect" for a not-connected grant.
    const signIn = await screen.findByRole('button', { name: 'Connect Asana account' });
    await waitFor(() => expect(signIn).toBeEnabled());
    await userEvent.click(signIn);
    await waitFor(() => expect(h.poll).toHaveBeenCalled());
    expect(h.start).toHaveBeenCalledWith({ mcp_server_id: server.mcp_server_id });
    expect(h.patch).not.toHaveBeenCalled();
    expect(window.open).toHaveBeenCalledWith(authorizationUrl, '_blank', 'noopener,noreferrer');
    expect(refresh).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
    h.complete({ status: 'succeeded' });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(h.status).toHaveBeenCalledOnce();
    expect(agorStore.getState().userAuthenticatedMcpServerIds.has(server.mcp_server_id)).toBe(true);
    // The inventory uses AntD's static portal; its queued render must settle
    // before teardown can destroy it and before the next attempt's assertions.
    await screen.findByText('OAuth authentication successful!');
  });

  it('saves Advanced configured-app settings with the redacted secret preserved before opening OAuth', async () => {
    const h = api();
    render(editor(h), { wrapper: Shell });
    const secret = await advanced();
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveValue('••••••••');
    await userEvent.fill(screen.getByLabelText('Client ID'), 'synthetic-replacement-app');
    await userEvent.click(screen.getByRole('button', { name: 'Start OAuth Flow' }));
    await screen.findByText('Waiting for authentication to complete in the browser tab...');
    expect(h.patch).toHaveBeenCalledWith(
      server.mcp_server_id,
      expect.objectContaining({
        url: server.url,
        transport: 'http',
        expected_config_version: 7,
        auth: expect.objectContaining({
          type: 'oauth',
          oauth_mode: 'per_user',
          oauth_dcr_mode: 'disabled',
          oauth_client_id: 'synthetic-replacement-app',
          oauth_client_secret: '••••••••',
        }),
      })
    );
    expect(h.patch.mock.invocationCallOrder[0]).toBeLessThan(h.start.mock.invocationCallOrder[0]);
    expect(h.status).not.toHaveBeenCalled();
    // window.open can return null with noopener or a blocked popup: neither is success.
    expect(screen.queryByText('OAuth authentication successful!')).not.toBeInTheDocument();
    h.complete({ status: 'succeeded' });
    await screen.findByText('OAuth authentication successful!');
    await waitFor(() =>
      expect(
        screen.queryByText('Waiting for authentication to complete in the browser tab...')
      ).not.toBeVisible()
    );
    expect(h.get).toHaveBeenCalledWith(server.mcp_server_id);
  });

  it('omits a blank saved secret from the Save patch instead of deleting it', async () => {
    const h = api();
    render(editor(h), { wrapper: Shell });
    await userEvent.clear(await advanced());
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledOnce());
    expect(h.patch.mock.calls[0]?.[1].auth).toMatchObject({
      type: 'oauth',
      oauth_client_id: 'synthetic-asana-app',
      oauth_dcr_mode: 'disabled',
    });
    expect(h.patch.mock.calls[0]?.[1].auth).not.toHaveProperty('oauth_client_secret');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('recovers from a failed start using the existing Advanced client secret and retry controls', async () => {
    const h = api();
    h.start.mockResolvedValueOnce({
      success: false,
      error: 'Synthetic client rejected. Check the configured app.',
    });
    render(editor(h), { wrapper: Shell });
    await userEvent.click(await screen.findByRole('button', { name: 'Start OAuth Flow' }));
    await screen.findByText('Synthetic client rejected. Check the configured app.');
    expect(window.open).not.toHaveBeenCalled();
    await userEvent.fill(await advanced(), 'synthetic-replacement-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Retry OAuth Flow' }));
    await screen.findByText('Waiting for authentication to complete in the browser tab...');
    expect(h.patch.mock.calls[1]?.[1]).toMatchObject({
      expected_config_version: 8,
      auth: { oauth_client_secret: 'synthetic-replacement-secret', oauth_dcr_mode: 'disabled' },
    });
    expect(
      screen.queryByText('Synthetic client rejected. Check the configured app.')
    ).not.toBeInTheDocument();
    h.complete({ status: 'expired' });
    await screen.findByText('OAuth sign-in expired. Start a new sign-in.');
    expect(h.status).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retry OAuth Flow' })).toBeEnabled();
  });

  it('discards private draft credentials and a pending completion when the authenticated identity changes', async () => {
    const h = api();
    const view = render(editor(h), { wrapper: Shell });
    await userEvent.fill(await advanced(), 'synthetic-alice-private-draft');
    await userEvent.click(screen.getByRole('button', { name: 'Start OAuth Flow' }));
    await waitFor(() => expect(h.poll).toHaveBeenCalled());
    view.rerender(editor(h, 'bob' as typeof catalogUser.user_id));
    h.complete({ status: 'succeeded' });
    expect(await advanced()).toHaveValue('••••••••');
    // Let the real polling interval pass: the old identity must not refetch/apply its grant.
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    expect(h.status).not.toHaveBeenCalled();
    expect(agorStore.getState().userAuthenticatedMcpServerIds.size).toBe(0);
    expect(screen.queryByText('OAuth authentication successful!')).not.toBeInTheDocument();
  });
});
