import type { MCPCatalogReadiness } from '@agor/core/types';
import { cleanup, render, screen } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { checkBrowserSanity } from '../../test/browserSanity';
import { CatalogDetailDrawer, type CatalogDetailDrawerProps } from './CatalogDetailDrawer';
import { catalogEntry } from './MCPCatalogModal.test-fixtures';

// Real drawer, AntD controls and browser; only backend eligibility and the
// provider-window boundary are fake. These tests do not certify Cloud consent.
checkBrowserSanity();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const disclosure = 'Fake provider: Cloud processes credentials in the approved region.';
const readiness: MCPCatalogReadiness = {
  catalog_key: catalogEntry.name,
  state: 'oauth_required',
  managed_oauth: { available: true, whole_cell_eligible: true, disclosure },
};

function props(): CatalogDetailDrawerProps {
  return {
    identityKey: 'caller-a',
    entry: { ...catalogEntry, auth_type: 'oauth' },
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
      role: 'member',
      isAdmin: false,
      policy: 'allow_crud',
      userId: 'caller-a',
      canConfigure: true,
    },
    policyPending: false,
    policyPendingHint: '',
    readiness,
    onConnect: vi.fn(),
  };
}

function drawer(input: CatalogDetailDrawerProps) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <CatalogDetailDrawer {...input} />
      </App>
    </ConfigProvider>
  );
}

describe('managed Catalog opt-in', () => {
  it('defaults to direct, requires renewed disclosure acknowledgement and submits explicit managed choice', async () => {
    const input = props();
    const navigate = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      opener: null,
      document: { title: '', body: { textContent: '' } },
      location: { replace: navigate },
      close: vi.fn(),
      closed: false,
    } as unknown as Window);
    render(drawer(input));
    const choice = await screen.findByRole('checkbox', { name: 'Use Agor-managed sign-in' });
    expect(choice).not.toBeChecked();
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    await userEvent.click(choice);
    expect(screen.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    expect(screen.getByText(disclosure)).toBeVisible();
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Connect', exact: true }));
    expect(input.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthClientMode: 'cloud_managed_v1',
        acknowledgedManagedDisclosure: disclosure,
        acknowledgedDisclosure: catalogEntry.permission_disclosure,
      })
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not silently fall back when eligibility disappears, or retain consent across caller swap', async () => {
    const input = props();
    const view = render(drawer(input));
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Use Agor-managed sign-in' })
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    view.rerender(
      drawer({ ...input, readiness: { catalog_key: catalogEntry.name, state: 'oauth_required' } })
    );
    expect(await screen.findByText('Agor-managed sign-in is unavailable')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    view.rerender(drawer({ ...input, identityKey: 'caller-b' }));
    expect(
      await screen.findByRole('checkbox', { name: 'Use Agor-managed sign-in' })
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
    expect(input.onConnect).not.toHaveBeenCalled();
  });

  it('does not offer managed from a missing whole-cell capability and preserves pending attachment state', async () => {
    const input = props();
    const view = render(drawer({ ...input, readiness: null }));
    expect(screen.queryByRole('checkbox', { name: 'Use Agor-managed sign-in' })).toBeNull();
    view.rerender(
      drawer({
        ...input,
        success: {
          catalogKey: catalogEntry.name,
          serverId: 'new-caller-owned-row',
          authentication: 'pending',
          reusedExistingServer: false,
          managedOAuth: true,
        },
      })
    );
    expect(
      await screen.findByText(/Existing connections and session attachments are unchanged/)
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start new session' })).toBeDisabled();
    window.postMessage({ success: true, serverId: 'new-caller-owned-row' }, '*');
    expect(screen.getByRole('button', { name: 'Start new session' })).toBeDisabled();
    expect(input.onConnect).not.toHaveBeenCalled();
  });
});
