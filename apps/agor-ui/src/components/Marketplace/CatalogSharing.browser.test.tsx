import type {
  MCPCatalogEntry,
  MCPCatalogReadiness,
  MCPCatalogSharing,
  MCPMemberPolicy,
} from '@agor/core/types';
import { MCP_MEMBER_POLICY_CHANGED_EVENT } from '@agor/core/types';
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

function fixture(role = 'admin', initialPolicy: MCPMemberPolicy = 'allow_crud') {
  let policy = initialPolicy;
  const listeners = new Map<string, Set<() => void>>();
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
  const events = {
    on: vi.fn((event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    }),
    off: vi.fn((event: string, listener: () => void) => listeners.get(event)?.delete(listener)),
    removeListener: vi.fn(),
  };
  const client = {
    io: events,
    service: (name: string) => {
      switch (name) {
        case 'mcp-catalog':
          return { find: async () => ({ data: [linear, notion] }) };
        case 'mcp-catalog/readiness':
          return { get };
        case 'mcp-member-policy':
          return {
            ...events,
            find: async () => ({
              policy,
              can_configure: role === 'admin' || policy !== 'use_existing_only',
            }),
          };
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
            currentUser={{ user_id: 'alice', role } as User}
          />
        </App>
      </ConfigProvider>
    </MemoryRouter>
  );
  return {
    async setPolicy(next: MCPMemberPolicy) {
      policy = next;
      await act(async () => {
        listeners.get(MCP_MEMBER_POLICY_CHANGED_EVENT)?.forEach((listener) => {
          listener();
        });
      });
    },
    pending,
    get,
    connect,
    async finish(
      index: number,
      state: MCPCatalogReadiness['state'] = 'oauth_required',
      shared = false
    ) {
      await act(async () =>
        pending[index].resolve({
          catalog_key: pending[index].key,
          state,
          ...(shared
            ? {
                shared_configuration_available: true,
                reusable_configuration: pending[index].sharing === 'shared',
              }
            : {}),
        })
      );
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

it.each(['use_existing_only', 'allow_private_only'] as const)(
  'offers explicit shared reuse, not publication under %s',
  async (policy) => {
    const api = fixture('member', policy);
    await userEvent.click(page.getByRole('button', { name: 'Open Linear', exact: true }));
    await waitFor(() => expect(api.pending).toHaveLength(1));
    const drawer = within(await screen.findByRole('dialog'));
    expect(drawer.queryByRole('radio', { name: 'Use existing shared' })).toBeNull();
    await api.finish(0, 'oauth_required', true);
    await userEvent.click(page.getByRole('radio', { name: 'Use existing shared', exact: true }));
    await userEvent.click(
      page.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    await waitFor(() => expect(api.pending).toHaveLength(2));
    expect(drawer.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(drawer.queryByRole('radio', { name: 'Shared' })).toBeNull();
    expect(drawer.getByText('Connect with Linear')).toBeVisible();
    await api.finish(1, 'oauth_required', true);
    await waitFor(() => expect(drawer.getByRole('button', { name: 'Connect' })).toBeEnabled());
  }
);

it('keeps a visible shared reuse selection on policy downgrade, disabled until a fresh read confirms it', async () => {
  const api = fixture('member');
  await userEvent.click(page.getByRole('button', { name: 'Open Linear', exact: true }));
  await waitFor(() => expect(api.pending).toHaveLength(1));
  await api.finish(0);
  await userEvent.click(page.getByRole('radio', { name: 'Shared', exact: true }));
  await userEvent.click(
    page.getByRole('checkbox', { name: 'I understand what this server can access' })
  );
  await waitFor(() => expect(api.pending).toHaveLength(2));
  // Policy changes while the selected ownership's previous read is held.
  await api.setPolicy('use_existing_only');
  const drawer = within(await screen.findByRole('dialog'));
  await waitFor(() =>
    expect(drawer.getByRole('radio', { name: 'Use existing shared' })).toBeChecked()
  );
  expect(drawer.getByRole('button', { name: 'Connect' })).toBeDisabled();
  await waitFor(() => expect(api.pending.length).toBeGreaterThan(2));
  await api.finish(1, 'installed_ready', true);
  expect(drawer.getByRole('button', { name: 'Connect' })).toBeDisabled();
  expect(drawer.queryByText('Ready to use')).toBeNull();
  await api.finish(api.pending.length - 1, 'oauth_required', true);
  await waitFor(() => expect(drawer.getByRole('button', { name: 'Connect' })).toBeEnabled());
  await api.setPolicy('allow_private_only');
  expect(drawer.getByRole('button', { name: 'Connect' })).toBeDisabled();
  await waitFor(() => expect(api.pending.length).toBeGreaterThan(3));
  await api.finish(api.pending.length - 1);
  await waitFor(() => expect(drawer.getByRole('button', { name: 'Connect' })).toBeDisabled());
  expect(drawer.getByRole('radio', { name: 'Use existing shared' })).toBeChecked();
  expect(drawer.getByText(/No eligible shared installation is available/)).toBeVisible();
  await userEvent.click(page.getByRole('radio', { name: 'Private', exact: true }));
  expect(drawer.getByRole('radio', { name: 'Private' })).toBeChecked();
  expect(api.connect).not.toHaveBeenCalled();
});
