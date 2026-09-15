import type { AgorClient } from '@agor-live/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkBrowserSanity } from '../../test/browserSanity';
import { ManagedOAuthCompletePage } from './ManagedOAuthCompletePage';
import { captureManagedOAuthReturn, MANAGED_POPUP_FLOW_KEY } from './managedOAuthReturn';

checkBrowserSanity();
const nonce = '00000000-0000-4000-8000-000000000001';
const flow = {
  nonce,
  userId: 'caller-a',
  serverId: 'server-a',
  attemptId: 'attempt-a',
  transactionId: 'transaction-a',
  createdAt: 0,
};
const originalPath = window.location.pathname;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.history.replaceState(null, '', originalPath);
  vi.restoreAllMocks();
});
function returned(
  overrides: Record<string, unknown> = {},
  fragment = `ticket=${'f'.repeat(43)}&transaction_id=transaction-a`
) {
  sessionStorage.setItem(
    MANAGED_POPUP_FLOW_KEY,
    JSON.stringify({ ...flow, createdAt: Date.now(), ...overrides })
  );
  window.history.replaceState(null, '', `/mcp-oauth/complete#${fragment}`);
  captureManagedOAuthReturn();
  expect(window.location.hash).toBe('');
}
function fakeClient() {
  const accept = vi.fn(async (_input: unknown) => ({ accepted: true, attempt_id: 'attempt-a' }));
  const attempt = vi.fn(async () => ({ status: 'succeeded', mcp_server_id: 'server-a' }));
  const status = vi.fn(async () => ({ authenticated_server_ids: ['server-a'] }));
  const get = vi.fn(async () => ({ mcp_server_id: 'server-a', enabled: true }));
  const client = {
    service: (path: string) => {
      if (path === 'mcp-servers/oauth-managed-return') return { create: accept };
      if (path === 'mcp-servers/oauth-attempt-status') return { get: attempt };
      if (path === 'mcp-servers/oauth-status') return { find: status };
      if (path === 'mcp-servers') return { get };
      throw new Error('Unexpected service');
    },
  } as unknown as AgorClient;
  return { client, accept, attempt, status, get };
}
function page(client: AgorClient, userId = 'caller-a', authorityKey = 'a:1') {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <ManagedOAuthCompletePage client={client} userId={userId} authorityKey={authorityKey} />
    </ConfigProvider>
  );
}

describe('managed provider return in real browser UI', () => {
  it('clears the fragment before any POST and shows Connected only after both durable reads', async () => {
    returned();
    const api = fakeClient();
    let resolve!: (value: { authenticated_server_ids: string[] }) => void;
    api.status.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    render(page(api.client));
    await waitFor(() => expect(api.status).toHaveBeenCalledOnce());
    expect(screen.queryByText('Connected')).toBeNull();
    expect(api.accept).toHaveBeenCalledWith({
      transaction_id: 'transaction-a',
      ticket: 'f'.repeat(43),
      client_nonce: nonce,
    });
    expect(sessionStorage.getItem(MANAGED_POPUP_FLOW_KEY)).toBeNull();
    resolve({ authenticated_server_ids: ['server-a'] });
    expect(await screen.findByText('Connected')).toBeVisible();
    expect(screen.getByText(/Existing session attachments are unchanged/)).toBeVisible();
  });
  it.each([
    { userId: 'caller-b' },
    { transactionId: 'another-transaction' },
    { nonce: '' },
    { createdAt: 1 },
  ])('refuses unknown/swapped/expired popup binding %j without POST', async (overrides) => {
    returned(overrides);
    const api = fakeClient();
    render(page(api.client));
    expect(await screen.findByText('Sign-in could not be verified')).toBeVisible();
    expect(api.accept).not.toHaveBeenCalled();
  });
  it('refuses duplicate fragment fields and one-shot replay', async () => {
    returned({}, `ticket=${'f'.repeat(43)}&ticket=${'g'.repeat(43)}&transaction_id=transaction-a`);
    const api = fakeClient();
    const view = render(page(api.client));
    expect(await screen.findByText('Sign-in could not be verified')).toBeVisible();
    view.unmount();
    render(page(api.client));
    expect(await screen.findByText('Sign-in could not be verified')).toBeVisible();
    expect(api.accept).not.toHaveBeenCalled();
  });
  it('does not use ticket acceptance after caller/authority swap', async () => {
    returned();
    const api = fakeClient();
    let resolve!: (value: { accepted: boolean; attempt_id: string }) => void;
    api.accept.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const view = render(page(api.client));
    await waitFor(() => expect(api.accept).toHaveBeenCalledOnce());
    view.rerender(page(api.client, 'caller-b', 'b:2'));
    resolve({ accepted: true, attempt_id: 'attempt-a' });
    expect(await screen.findByText('Sign-in could not be verified')).toBeVisible();
    expect(api.attempt).not.toHaveBeenCalled();
    expect(screen.queryByText('Connected')).toBeNull();
  });
  it('does not promote accepted ticket or succeeded attempt without caller credential', async () => {
    returned();
    const api = fakeClient();
    api.status.mockResolvedValue({ authenticated_server_ids: [] });
    render(page(api.client));
    expect(await screen.findByText('Sign-in could not be verified')).toBeVisible();
    expect(screen.queryByText('Connected')).toBeNull();
  });
});
