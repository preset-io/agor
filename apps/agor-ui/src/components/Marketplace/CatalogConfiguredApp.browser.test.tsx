import type { MCPCatalogEntry } from '@agor/core/types';
import { cleanup, render } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { CatalogDetailDrawer, type CatalogDetailDrawerProps } from './CatalogDetailDrawer';

const entry: MCPCatalogEntry = {
  name: 'test/customer-app',
  title: 'Fake provider',
  category: 'productivity',
  capabilities: ['tasks'],
  has_remote: true,
  remote_url: 'https://fake-provider.example/mcp',
  transport: 'streamable-http',
  auth_type: 'oauth',
  permission_disclosure: 'Reads fake tasks.',
  oauth: {
    dcr_mode: 'disabled',
    configured_client: {
      setup_url: 'https://fake-provider.example/apps',
      issuer: 'https://fake-provider.example',
      secret_required: true,
    },
  },
};
afterEach(cleanup);
it('keeps configured app IDs and secrets in the secure form, requires consent, and clears them on close', async () => {
  const connect = vi.fn<CatalogDetailDrawerProps['onConnect']>((input) =>
    input.oauthPopup?.close()
  );
  const props: CatalogDetailDrawerProps = {
    identityKey: 'alice',
    readiness: {
      catalog_key: entry.name,
      state: 'oauth_required',
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
  const view = render(
    <ConfigProvider>
      <App>
        <CatalogDetailDrawer {...props} />
      </App>
    </ConfigProvider>
  );
  const button = page.getByRole('button', { name: 'Connect', exact: true });
  await expect.element(button).toBeDisabled();
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
