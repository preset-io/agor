import type { Branch, MCPCatalogEntry } from '@agor/core/types';
import { load } from '@agor/core/yaml';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import catalogYaml from '../../../../../packages/core/src/mcp-catalog/curated.yaml?raw';
import { OAUTH_PROVIDER_FIXTURES } from '../../../../../packages/core/src/tools/mcp/oauth-provider.test-fixtures';
import { checkBrowserSanity } from '../../test/browserSanity';
import { CatalogDetailDrawer, type CatalogDetailDrawerProps } from './CatalogDetailDrawer';
import { connectStatus, isConnectable } from './catalogPresentation';

checkBrowserSanity();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const catalog = load(catalogYaml) as { entries: MCPCatalogEntry[]; unpublished: MCPCatalogEntry[] };

function drawer(entry: MCPCatalogEntry, overrides: Partial<CatalogDetailDrawerProps> = {}) {
  let props: CatalogDetailDrawerProps = {
    identityKey: 'tenant-a:member-a',
    entry: { ...entry, icon_url: undefined, has_remote: true },
    open: true,
    onClose: vi.fn(),
    branches: [{ branch_id: 'branch-a', name: 'OAuth test branch' }] as Branch[],
    branchesLoading: false,
    branchesError: null,
    defaultBranchId: 'branch-a',
    connecting: false,
    connectError: null,
    onConnect: vi.fn(),
    connectCapability: {
      connectionReady: true,
      role: 'member',
      isAdmin: false,
      policy: 'allow_private_only',
      userId: 'member-a',
      canConfigure: true,
    },
    policyPending: false,
    policyPendingHint: 'Checking workspace policy',
    ...overrides,
  };
  const view = render(<CatalogDetailDrawer {...props} />);
  return {
    props,
    change(next: Partial<CatalogDetailDrawerProps>) {
      props = { ...props, ...next };
      view.rerender(<CatalogDetailDrawer {...props} />);
    },
  };
}

describe('ordinary provider OAuth in real Chromium', () => {
  it.each(OAUTH_PROVIDER_FIXTURES)(
    '$label allows an authorized member to connect without a provider gate or special confirmation',
    async ({ name }) => {
      const entry = [...catalog.entries, ...catalog.unpublished].find(
        (entry) => entry.name === name
      )!;
      const { props, change } = drawer(entry);
      const popup = vi.spyOn(window, 'open');
      expect(isConnectable(entry)).toBe(true);
      expect(connectStatus(entry).readiness).toBe('sign-in');
      const connect = await screen.findByRole('button', { name: /Connect with/ });
      expect(connect).toBeDisabled();
      expect(screen.queryByText('Provider setup required')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Provider setup guide' })).toBeNull();
      expect(
        screen.queryByRole('button', { name: /registration anyway|Confirm diagnostic/ })
      ).toBeNull();
      expect(props.onConnect).not.toHaveBeenCalled();
      expect(popup).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('checkbox', { name: /I understand/ }));
      await userEvent.click(connect);
      expect(props.onConnect).toHaveBeenCalledWith({
        branchId: 'branch-a',
        agenticTool: 'claude-code',
        acknowledgedDisclosure: entry.permission_disclosure,
        oauthPopup: expect.any(Object),
      });
      const opened = popup.mock.results[0]?.value as Window | null;
      expect(opened).not.toBeNull();
      expect(opened?.opener).toBeNull();
      opened?.close();
      change({ connecting: true });
      expect(screen.getByRole('button', { name: /Connect with/ })).toBeDisabled();
      change({
        connecting: false,
        connectError:
          'The provider could not register an OAuth client automatically. Review provider setup with an administrator.',
      });
      const failure = screen.getByText(/The provider could not register/);
      failure.scrollIntoView();
      expect(failure).toBeVisible();
      expect(screen.getByRole('button', { name: /Connect with/ })).toBeEnabled();
      if (name === 'com.dropbox/mcp') await page.screenshot();
      await waitFor(() => {
        const bounds = screen.getByRole('dialog').getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      });
      expect(document.body.textContent).not.toContain('SENTINEL');
    }
  );

  it.each(['member_policy', 'viewer', 'policy_pending', 'disconnected'])(
    'retains the original %s permission guard',
    async (state) => {
      const entry = [...catalog.entries, ...catalog.unpublished].find(
        (entry) => entry.name === 'com.dropbox/mcp'
      )!;
      const { props } = drawer(entry, {
        policyPending: state === 'policy_pending',
        connectCapability: {
          connectionReady: state !== 'disconnected',
          role: state === 'viewer' ? 'viewer' : 'member',
          isAdmin: false,
          policy: 'use_existing_only',
          userId: 'member-a',
          canConfigure: state !== 'member_policy',
        },
      });
      const popup = vi.spyOn(window, 'open');
      await userEvent.click(await screen.findByRole('checkbox', { name: /I understand/ }));
      expect(screen.getByRole('button', { name: /Connect with/ })).toBeDisabled();
      expect(props.onConnect).not.toHaveBeenCalled();
      expect(popup).not.toHaveBeenCalled();
    }
  );

  it('closing before Connect performs no registration and changing identity clears disclosure consent', async () => {
    const entry = [...catalog.entries, ...catalog.unpublished].find(
      (entry) => entry.name === 'com.dropbox/mcp'
    )!;
    const { props, change } = drawer(entry);
    const popup = vi.spyOn(window, 'open');
    await userEvent.click(await screen.findByRole('checkbox', { name: /I understand/ }));
    change({ open: false });
    expect(props.onConnect).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
    change({ open: true, identityKey: 'tenant-b:member-b' });
    expect(await screen.findByRole('checkbox', { name: /I understand/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Connect with/ })).toBeDisabled();
  });
});
