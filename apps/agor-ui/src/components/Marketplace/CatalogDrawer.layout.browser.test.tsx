import type { MCPCatalogEntry } from '@agor/core/types';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { checkBrowserSanity } from '../../test/browserSanity';
import { CatalogDetailDrawer, type CatalogDetailDrawerProps } from './CatalogDetailDrawer';

checkBrowserSanity();
afterEach(cleanup);
const entry = {
  name: 'com.deepwiki/mcp',
  category: 'dev-tools',
  starter_prompt: 'Explain a public repository.',
  title: 'DeepWiki',
  benefit: 'Explore public repositories',
  permission_disclosure: 'Reads public repositories.',
  capabilities: [],
  auth_type: 'none',
  has_remote: true,
  remote_url: 'https://mcp.deepwiki.com/mcp',
  transport: 'streamable-http',
} as MCPCatalogEntry;
const props: CatalogDetailDrawerProps = {
  identityKey: 'test-user',
  entry: null,
  open: true,
  onClose: vi.fn(),
  teammates: [],
  teammatesLoading: false,
  teammatesError: null,
  defaultTeammateId: null,
  connecting: false,
  startingSession: false,
  startSessionError: null,
  connectError: null,
  connectCapability: {
    connectionReady: true,
    role: 'admin',
    isAdmin: true,
    policy: 'allow_crud',
    userId: 'test-user',
    canConfigure: true,
  },
  policyPending: false,
  policyPendingHint: '',
  onConnect: vi.fn(),
};
it('keeps one drawer through loading and uses historical shared disclosure spacing', async () => {
  const width = window.innerWidth;
  const afterOpen = vi.fn();
  const view = render(
    <ConfigProvider>
      <CatalogDetailDrawer
        {...props}
        onAfterOpenChange={afterOpen}
        emptyContent={<span role="status">Loading catalog…</span>}
      />
    </ConfigProvider>
  );
  await screen.findByText('Loading catalog…');
  await waitFor(() => expect(afterOpen).toHaveBeenCalledWith(true));
  const root = document.querySelector('.ant-drawer');
  const wrapper = document.querySelector('.ant-drawer-content-wrapper');
  view.rerender(
    <ConfigProvider>
      <CatalogDetailDrawer {...props} entry={entry} onAfterOpenChange={afterOpen} />
    </ConfigProvider>
  );
  await screen.findByText('Explore public repositories');
  expect(document.querySelectorAll('.ant-drawer')).toHaveLength(1);
  expect(document.querySelector('.ant-drawer')).toBe(root);
  expect(document.querySelector('.ant-drawer-content-wrapper')).toBe(wrapper);
  expect(afterOpen.mock.calls).toEqual([[true]]);
  expect(wrapper!.getBoundingClientRect().width).toBe(Math.min(520, width));
  const header = document.querySelector('.ant-drawer-header')!;
  const body = document.querySelector('.ant-drawer-body')!;
  expect(getComputedStyle(header).padding).toBe('16px 24px');
  expect(getComputedStyle(body).padding).toBe('24px');
  const disclosure = screen.getByRole('button', { name: 'What this can access' });
  expect(getComputedStyle(disclosure).padding).toBe('12px');
  const content = document.querySelector('.ant-collapse-body')!;
  expect(getComputedStyle(content).padding).toBe('16px');
  expect(disclosure.getBoundingClientRect().height).toBeGreaterThanOrEqual(32);
  const icon = disclosure.querySelector('.ant-collapse-expand-icon')!;
  expect(icon.getBoundingClientRect().left - disclosure.getBoundingClientRect().left).toBe(12);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  disclosure.focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(disclosure.getAttribute('aria-expanded')).toBe('false'));
  expect(document.activeElement).toBe(disclosure);
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(disclosure.getAttribute('aria-expanded')).toBe('true'));
  await userEvent.keyboard(' ');
  await waitFor(() => expect(disclosure.getAttribute('aria-expanded')).toBe('false'));
  await userEvent.keyboard(' ');
  await waitFor(() => expect(disclosure.getAttribute('aria-expanded')).toBe('true'));
  expect(document.activeElement).toBe(disclosure);
  const consent = screen.getByRole('checkbox');
  consent.focus();
  await userEvent.keyboard(' ');
  expect(consent).toBeChecked();
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  await page.screenshot({ path: `./__screenshots__/parent-drawer-${window.innerWidth}.png` });
  expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
  expect(document.querySelector('.ant-drawer-footer')).toBeNull();
});
