import type { MCPCatalogEntry, MCPCatalogReadiness, MCPCatalogSharing } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { checkBrowserSanity } from '../../test/browserSanity';
import { CatalogTab } from './CatalogTab';

checkBrowserSanity();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(cleanup);

const linear: MCPCatalogEntry = {
  name: 'app.linear/linear',
  title: 'Linear',
  category: 'productivity',
  capabilities: ['issues'],
  benefit: 'Work with issues.',
  starter_prompt: 'Summarize my issues.',
  has_remote: true,
  remote_url: 'https://mcp.linear.app/mcp',
  transport: 'streamable-http',
  auth_type: 'oauth',
  permission_disclosure: 'Reads and writes issues in the Linear workspaces you authorise.',
};
const notion: MCPCatalogEntry = { ...linear, name: 'com.notion/mcp', title: 'Notion' };

function fixture() {
  const pending: {
    key: string;
    sharing: MCPCatalogSharing;
    resolve: (value: MCPCatalogReadiness) => void;
  }[] = [];
  const get = vi.fn(
    (key: string, params: { query: { sharing: MCPCatalogSharing } }) =>
      new Promise<MCPCatalogReadiness>((resolve) => {
        pending.push({ key, sharing: params.query.sharing, resolve });
      })
  );
  const connect = vi.fn();
  const events = { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
  const client = {
    io: events,
    service: (name: string) => {
      switch (name) {
        case 'mcp-catalog':
          return { find: async () => ({ data: [linear, notion] }) };
        case 'mcp-catalog/readiness':
          return { get };
        case 'mcp-member-policy':
          return { find: async () => ({ policy: 'allow_crud', can_configure: true }) };
        case 'mcp-catalog/connect':
          return { create: connect };
        case 'mcp-servers':
          return events;
        default:
          throw new Error(`Unexpected service: ${name}`);
      }
    },
  } as unknown as AgorClient;
  render(
    <MemoryRouter>
      <ConfigProvider>
        <App>
          <CatalogTab
            client={client}
            connected
            connecting={false}
            authGeneration={1}
            currentUser={{ user_id: 'alice', role: 'admin' } as User}
          />
        </App>
      </ConfigProvider>
    </MemoryRouter>
  );
  return {
    pending,
    get,
    connect,
    async finish(index: number, state: MCPCatalogReadiness['state'] = 'oauth_required') {
      await act(async () => pending[index].resolve({ catalog_key: pending[index].key, state }));
    },
  };
}

it('keeps provider copy stable across held sharing reads, rapid toggles, and keyboard changes', async () => {
  const api = fixture();
  await userEvent.click(page.getByRole('button', { name: 'Open Linear', exact: true }));
  await waitFor(() => expect(api.pending).toHaveLength(1));
  await api.finish(0);
  const dialog = await screen.findByRole('dialog');
  const drawer = within(dialog);
  await drawer.findByText('Connect with Linear');
  const labels: string[] = [];
  const observer = new MutationObserver(() => {
    for (const alert of dialog.querySelectorAll('[role="alert"]'))
      labels.push(alert.textContent ?? '');
  });
  observer.observe(dialog, { subtree: true, childList: true, characterData: true });
  try {
    for (const [index, sharing] of ['shared', 'private'].entries()) {
      await userEvent.click(
        page.getByRole('radio', { name: sharing === 'shared' ? 'Shared' : 'Private', exact: true })
      );
      expect(drawer.getByText('Connect with Linear')).toBeVisible();
      expect(drawer.queryByText('Connect with your account')).toBeNull();
      await waitFor(() => expect(api.pending).toHaveLength(index + 2));
      expect(api.pending[index + 1].sharing).toBe(sharing);
      expect(drawer.getByText('Connect with Linear')).toBeVisible();
      expect(drawer.getByRole('button', { name: 'Connect' })).toBeDisabled();
      await api.finish(index + 1);
      await waitFor(() => expect(drawer.getByText('Connect with Linear')).toBeVisible());
    }
    // A stale shared response must not install its "Ready to use" presentation.
    await userEvent.click(page.getByRole('radio', { name: 'Shared', exact: true }));
    await waitFor(() => expect(api.pending).toHaveLength(4));
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(drawer.getByRole('radio', { name: 'Private' })).toBeChecked());
    await waitFor(() => expect(api.pending).toHaveLength(5));
    await api.finish(4);
    await api.finish(3, 'installed_ready');
    for (let index = 0; index < 6; index++)
      await userEvent.keyboard(index % 2 === 0 ? '{ArrowRight}' : '{ArrowLeft}');
    await waitFor(() => expect(drawer.getByRole('radio', { name: 'Private' })).toBeChecked());
    expect(drawer.getByText('Connect with Linear')).toBeVisible();
    expect(drawer.queryByText('Ready to use')).toBeNull();
    expect(labels.some((label) => label.includes('Connect with your account'))).toBe(false);
    expect(api.connect).not.toHaveBeenCalled();
  } finally {
    observer.disconnect();
  }
});

it('uses the new entry identity while a previous entry readiness response arrives late', async () => {
  const api = fixture();
  await userEvent.click(page.getByRole('button', { name: 'Open Linear', exact: true }));
  await waitFor(() => expect(api.pending).toHaveLength(1));
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await userEvent.click(page.getByRole('button', { name: 'Open Notion', exact: true }));
  await waitFor(() => expect(api.pending).toHaveLength(2));
  const drawer = within(await screen.findByRole('dialog'));
  expect(drawer.getByText('Connect with Notion')).toBeVisible();
  await api.finish(0, 'installed_ready');
  await api.finish(1);
  await waitFor(() => expect(drawer.getByText('Connect with Notion')).toBeVisible());
  expect(drawer.queryByText('Connect with Linear')).toBeNull();
  expect(drawer.queryByText('Ready to use')).toBeNull();
  expect(drawer.getByRole('button', { name: 'Connect' })).toBeDisabled();
  expect(api.connect).not.toHaveBeenCalled();
});
