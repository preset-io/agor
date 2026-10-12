import type { MCPCatalogEntry } from '@agor/core/types';
import { cleanup, render } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { CatalogDetailDrawer, type CatalogDetailDrawerProps } from './CatalogDetailDrawer';

const entry: MCPCatalogEntry = {
  name: 'com.asana/mcp',
  title: 'Asana',
  category: 'productivity',
  capabilities: ['tasks'],
  has_remote: true,
  remote_url: 'https://mcp.asana.com/v2/mcp',
  transport: 'streamable-http',
  auth_type: 'oauth',
  permission_disclosure: 'Reads tasks.',
  oauth: {
    dcr_mode: 'disabled',
    configured_client: {
      setup_url: 'https://developers.asana.com/docs/integrating-with-asanas-mcp-server',
      issuer: 'https://app.asana.com',
      secret_required: true,
    },
  },
};
function makeProps(
  entry: MCPCatalogEntry,
  connect: CatalogDetailDrawerProps['onConnect']
): CatalogDetailDrawerProps {
  return {
    identityKey: 'alice',
    readiness: {
      catalog_key: entry.name,
      state: entry.auth_type === 'credentials' ? 'bearer_required' : 'oauth_required',
      redirect_uri: 'https://relay.example.test/callback',
    },
    entry,
    open: true,
    onClose: () => {},
    teammates: [],
    teammatesLoading: false,
    teammatesError: null,
    connecting: false,
    startingSession: false,
    startSessionError: null,
    connectError: null,
    policyPending: false,
    policyPendingHint: '',
    onConnect: connect,
    connectCapability: {
      connectionReady: true,
      role: 'admin',
      isAdmin: true,
      policy: 'allow_crud',
      userId: 'alice',
      canConfigure: true,
    },
  };
}
afterEach(cleanup);
it('shows Asana app setup without a bearer field, keeps IDs and secrets in the secure form, requires consent, and clears them on close', async () => {
  const connect = vi.fn<CatalogDetailDrawerProps['onConnect']>((input) =>
    input.oauthPopup?.close()
  );
  const props = makeProps(entry, connect);
  const view = render(
    <ConfigProvider>
      <App>
        <CatalogDetailDrawer {...props} />
      </App>
    </ConfigProvider>
  );
  await expect
    .element(page.getByPlaceholder('Paste your Asana bearer access token'))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText('https://relay.example.test/callback', { exact: true }))
    .toBeVisible();
  const button = page.getByRole('button', { name: 'Connect', exact: true });
  await expect.element(button).toBeDisabled();
  await expect.element(page.getByRole('radio', { name: 'Shared', exact: true })).toBeEnabled();
  await expect.element(page.getByRole('radio', { name: 'Private', exact: true })).toBeChecked();
  await page.getByLabelText('OAuth app Client ID', { exact: true }).fill('customer-app');
  await page.getByLabelText('OAuth app Client secret', { exact: true }).fill('fake-client-secret');
  await expect
    .element(page.getByLabelText('OAuth app Client secret', { exact: true }))
    .toHaveAttribute('type', 'password');
  await expect
    .element(page.getByLabelText('OAuth app Client ID', { exact: true }))
    .toHaveValue('customer-app');
  await expect.element(button).toBeDisabled();
  await page.getByRole('checkbox').click();
  await button.click();
  expect(connect).toHaveBeenCalledOnce();
  expect(connect.mock.calls[0][0].oauthClient).toEqual({
    client_id: 'customer-app',
    client_secret: 'fake-client-secret',
  });
  expect(connect.mock.calls[0][0]).not.toHaveProperty('bearerToken');
  expect(document.body.textContent).not.toContain('fake-client-secret');
  view.rerender(
    <ConfigProvider>
      <App>
        <CatalogDetailDrawer {...props} open={false} />
      </App>
    </ConfigProvider>
  );
  view.rerender(
    <ConfigProvider>
      <App>
        <CatalogDetailDrawer {...props} />
      </App>
    </ConfigProvider>
  );
  await expect.element(page.getByLabelText('OAuth app Client ID', { exact: true })).toHaveValue('');
  await expect
    .element(page.getByLabelText('OAuth app Client secret', { exact: true }))
    .toHaveValue('');
  await expect.element(button).toBeDisabled();
});

it('reuses an existing shared app install without asking for or sending app credentials', async () => {
  const connect = vi.fn<CatalogDetailDrawerProps['onConnect']>((input) =>
    input.oauthPopup?.close()
  );
  const props = makeProps(entry, connect);
  render(
    <ConfigProvider>
      <App>
        <CatalogDetailDrawer
          {...props}
          sharing="shared"
          readiness={{ ...props.readiness!, shared_configuration_available: true }}
        />
      </App>
    </ConfigProvider>
  );
  await expect
    .element(page.getByText('Uses the OAuth app already configured for this shared installation.'))
    .toBeVisible();
  await expect
    .element(page.getByLabelText('OAuth app Client ID', { exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole('checkbox').click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(connect).toHaveBeenCalledOnce();
  expect(connect.mock.calls[0][0]).not.toHaveProperty('oauthClient');
});

it('keeps genuine bearer setup private, submits only the key, and clears it on close', async () => {
  const bearerEntry: MCPCatalogEntry = {
    ...entry,
    name: 'test/bearer',
    title: 'Bearer provider',
    auth_type: 'credentials',
    oauth: undefined,
  };
  const connect = vi.fn<CatalogDetailDrawerProps['onConnect']>();
  const props = makeProps(bearerEntry, connect);
  const drawer = (open: boolean) => (
    <ConfigProvider>
      <App>
        <CatalogDetailDrawer {...props} open={open} />
      </App>
    </ConfigProvider>
  );
  const view = render(drawer(true));
  const key = page.getByPlaceholder('Paste your Bearer provider bearer access token');
  await expect.element(key).toBeVisible();
  await expect.element(key).toHaveAttribute('type', 'password');
  await expect
    .element(page.getByLabelText('OAuth app Client ID', { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByLabelText('OAuth app Client secret', { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole('radio', { name: 'Shared', exact: true })).toBeDisabled();
  await expect.element(page.getByRole('radio', { name: 'Private', exact: true })).toBeChecked();
  const button = page.getByRole('button', { name: 'Connect', exact: true });
  await page.getByRole('checkbox').click();
  await expect.element(button).toBeDisabled();
  await key.fill('synthetic-bearer-key');
  await button.click();
  expect(connect).toHaveBeenCalledOnce();
  expect(connect.mock.calls[0][0].bearerToken).toBe('synthetic-bearer-key');
  expect(connect.mock.calls[0][0]).not.toHaveProperty('oauthClient');
  view.rerender(drawer(false));
  view.rerender(drawer(true));
  await expect.element(key).toHaveValue('');
  await expect.element(button).toBeDisabled();
});
