import type { GatewayChannel, User } from '@agor-live/client';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { ONBOARDING_INTEGRATION_RECOMMENDATIONS as recs } from '../../utils/onboardingGoals';
import type { OnboardingSlackGatewayIntent } from '../../utils/onboardingSlack';
import {
  catalogUser,
  githubHandoffEntry,
  makeCatalogClient,
} from '../Marketplace/MCPCatalogModal.test-fixtures';
import { OnboardingToolsStep } from './OnboardingToolsStep';

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => {
  agorStore.setState({ ...EMPTY_MAPS });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const admin = { ...catalogUser, role: 'admin' } as User;
const existing = {
  id: 'gateway-1',
  name: 'Team bot',
  channel_type: 'slack',
  target_branch_id: 'branch-1',
  enabled: true,
} as GatewayChannel;
const oauthEntry = {
  ...githubHandoffEntry,
  name: 'app.linear/linear',
  title: 'Linear',
  auth_type: 'oauth' as const,
  credentials: undefined,
};
function apiFor(channels: GatewayChannel[] = [], oauth = false) {
  const api = makeCatalogClient(oauth ? [oauthEntry] : [githubHandoffEntry]);
  vi.mocked(api.client.service('gateway-channels').findAll).mockResolvedValue(channels);
  vi.mocked(api.client.service('branches/:id/effective-access').find).mockResolvedValue({
    capabilities: ['sessions.create'],
  } as never);
  return api;
}
function Harness({
  api,
  user = admin,
  generation = 1,
  onConnected = vi.fn(),
}: {
  api: ReturnType<typeof apiFor>;
  user?: User;
  generation?: number;
  onConnected?: (id: string) => void;
}) {
  const [slackSelected, setSlackSelected] = useState(true);
  const [intent, setIntent] = useState<OnboardingSlackGatewayIntent>('prefer-existing');
  return (
    <ConfigProvider>
      <App>
        <MemoryRouter>
          <OnboardingToolsStep
            client={api.client}
            user={user}
            connected
            authGeneration={generation}
            kit={[recs.github, recs.linear, recs.slack]}
            isSelected={(id) => id !== 'slack' || slackSelected}
            onToggle={(id) => {
              if (id === 'slack') setSlackSelected((value) => !value);
            }}
            onConnected={onConnected}
            gatewayIntent={intent}
            onGatewayIntent={setIntent}
          />
          <output data-testid="gateway-intent">{intent}</output>
        </MemoryRouter>
      </App>
    </ConfigProvider>
  );
}
async function openTool(title: string) {
  const card = screen.getByText(title).closest<HTMLElement>('.ant-card')!;
  await userEvent.click(within(card).getByRole('button', { name: /^Sign in through Catalog/ }));
  const dialog = await screen.findByRole('dialog', { name: new RegExp(title) });
  const wrapper = dialog.closest('.ant-drawer-content-wrapper')!;
  // The form can render before the drawer's enter animation finishes. Wait
  // for the real motion, rather than clicking a consent target still moving.
  await waitFor(() => {
    expect(dialog.getBoundingClientRect().right).toBeCloseTo(window.innerWidth, 1);
    expect(wrapper.getAnimations().some((animation) => animation.playState === 'running')).toBe(
      false
    );
  });
  return within(dialog);
}

describe('onboarding Slack and authority boundaries in Chromium', () => {
  it('resolves loading in one persistent drawer without a second portal, opening animation or focus reset', async () => {
    const api = apiFor();
    const find = vi.mocked(api.client.service('mcp-catalog').find);
    const result = await find();
    let resolve!: (value: typeof result) => void;
    find.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const pushState = vi.spyOn(window.history, 'pushState');
    render(<Harness api={api} />);
    // Exercise a native click after readiness resolves, including the focus-triggered refresh.
    await screen.findByText('Token required');
    const action = screen.getByRole('button', { name: 'Sign in through Catalog for GitHub' });
    await userEvent.click(action);
    const loading = await screen.findByRole('dialog', { name: 'Catalog' });
    const root = loading.closest('.ant-drawer')!;
    const wrapper = loading.closest('.ant-drawer-content-wrapper')!;
    await waitFor(() => {
      expect(loading.getBoundingClientRect().right).toBeCloseTo(window.innerWidth, 1);
      expect(wrapper.getAnimations().some((animation) => animation.playState === 'running')).toBe(
        false
      );
    });
    const cancel = within(loading).getByRole('button', { name: 'Close' });
    cancel.focus();
    const mounts: Element[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches('.ant-drawer') || node.querySelector('.ant-drawer'))
          )
            mounts.push(node);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    resolve(result);
    await screen.findByPlaceholderText('Paste your GitHub bearer access token');
    expect(document.querySelectorAll('.ant-drawer')).toHaveLength(1);
    expect(document.querySelector('.ant-drawer')).toBe(root);
    expect(document.querySelector('.ant-drawer-content-wrapper')).toBe(wrapper);
    expect(wrapper.getAnimations()).toHaveLength(0);
    expect(cancel).toHaveFocus();
    expect(mounts).toHaveLength(0);
    observer.disconnect();
    expect(pushState).not.toHaveBeenCalled();
    expect(api.client.service('mcp-catalog/start-session').create).not.toHaveBeenCalled();
    expect(api.client.service('users').getPrimaryTeammateCandidates).not.toHaveBeenCalled();
    await userEvent.click(cancel);
    await waitFor(() => expect(action).toHaveFocus());
  });
  it.each(['missing', 'error'] as const)(
    'retries %s Catalog locally in the same drawer',
    async (initial) => {
      const api = apiFor();
      const find = vi.mocked(api.client.service('mcp-catalog').find);
      if (initial === 'missing')
        find.mockResolvedValueOnce({ data: [], total: 0, limit: 1, skip: 0 });
      else find.mockRejectedValueOnce(new Error('fixture unavailable'));
      render(<Harness api={api} />);
      await userEvent.click(
        screen.getByRole('button', { name: 'Sign in through Catalog for GitHub' })
      );
      const dialog = await screen.findByRole('dialog', { name: 'Catalog' });
      const root = dialog.closest('.ant-drawer');
      const wrapper = dialog.closest('.ant-drawer-content-wrapper')!;
      // Error content can arrive during enter motion, just like the ready form.
      // Keep the native Retry click inside the settled drawer's hit target.
      await waitFor(() => {
        expect(dialog.getBoundingClientRect().right).toBeCloseTo(window.innerWidth, 1);
        expect(wrapper.getAnimations().some((animation) => animation.playState === 'running')).toBe(
          false
        );
      });
      await userEvent.click(await within(dialog).findByRole('button', { name: 'Retry' }));
      await screen.findByPlaceholderText('Paste your GitHub bearer access token');
      expect(document.querySelector('.ant-drawer')).toBe(root);
      expect(document.querySelector('.ant-drawer-content-wrapper')).toBe(wrapper);
      expect(document.querySelectorAll('.ant-drawer')).toHaveLength(1);
      expect(find).toHaveBeenCalledTimes(2);
      expect(api.connect).not.toHaveBeenCalled();
      expect(api.client.service('mcp-catalog/start-session').create).not.toHaveBeenCalled();
    }
  );
  it('prefers the usable existing gateway without exposing duplicate creation', async () => {
    const api = apiFor([existing]);
    render(<Harness api={api} />);
    await screen.findByText(/Prefer your existing Slack gateway: Team bot/);
    expect(
      screen.queryByRole('checkbox', { name: /create a new Slack gateway/ })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('gateway-intent')).toHaveTextContent('prefer-existing');
    expect(api.connect).not.toHaveBeenCalled();
    const list = screen.getByRole('list', { name: 'Suggested MCP tools' });
    expect(within(list).queryByText(/Slack/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: /Suggest Slack/ })).toHaveLength(1);
    expect(
      screen.getByRole('checkbox', { name: 'Suggest Slack gateway messaging to my teammate' })
    ).toBeChecked();
    expect(
      screen.queryByRole('checkbox', { name: 'Suggest Slack to my teammate' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Slack MCP tool access is not available.*not selected/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Slack MCP availability' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Slack MCP availability' })).not.toBeInTheDocument();
  });
  it('exposes new-gateway intent only for an authorized admin, never creates one on selection', async () => {
    const api = apiFor();
    render(<Harness api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId('gateway-intent')).toHaveTextContent('request-new')
    );
    const choice = screen.getByRole('checkbox', {
      name: 'Suggest Slack gateway messaging to my teammate',
    });
    const card = choice.closest<HTMLElement>('.ant-card')!;
    expect(within(card).getAllByRole('checkbox')).toHaveLength(1);
    expect(choice).toHaveAccessibleDescription(
      /existing Slack gateway channel.*none exists and permissions allow/
    );
    const github = screen.getByText('GitHub').closest<HTMLElement>('.ant-card')!;
    const logo = within(card).getByRole('img', { name: /logo/ });
    expect(logo.getBoundingClientRect().left).toBe(
      within(github).getByRole('img').getBoundingClientRect().left
    );
    expect(logo.getBoundingClientRect().width).toBe(20);
    expect(card.querySelector('.ant-card-head')).toBeNull();
    expect(getComputedStyle(within(card).getByText('Slack gateway messaging')).fontSize).toBe(
      '14px'
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Suggest Slack gateway messaging to my teammate' })
    );
    expect(screen.getByTestId('gateway-intent')).toHaveTextContent('prefer-existing');
    expect(choice).not.toBeChecked();
    choice.focus();
    await userEvent.keyboard(' ');
    await waitFor(() =>
      expect(screen.getByTestId('gateway-intent')).toHaveTextContent('request-new')
    );
    expect(choice).toHaveFocus();
    expect(api.client.service('gateway-channels').create).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
  });
  it('resets assistance intent on identity/role change and ignores a stale empty inventory', async () => {
    const api = apiFor();
    const view = render(<Harness api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId('gateway-intent')).toHaveTextContent('request-new')
    );
    let resolve!: (value: GatewayChannel[]) => void;
    vi.mocked(api.client.service('gateway-channels').findAll).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    view.rerender(<Harness api={api} generation={2} />);
    await screen.findByLabelText('Checking Slack gateways');
    expect(screen.getByTestId('gateway-intent')).toHaveTextContent('prefer-existing');
    view.rerender(<Harness api={api} generation={3} user={catalogUser} />);
    await screen.findByText(/An administrator must create one/);
    resolve([]);
    await waitFor(() =>
      expect(screen.getByTestId('gateway-intent')).toHaveTextContent('prefer-existing')
    );
    expect(api.client.service('gateway-channels').create).not.toHaveBeenCalled();
  });
  it('denies new-gateway intent to a member without offering Slack MCP UI', async () => {
    const api = apiFor();
    render(<Harness api={api} user={catalogUser} />);
    await screen.findByText(/An administrator must create one/);
    expect(
      screen.queryByRole('checkbox', { name: /create a new Slack gateway/ })
    ).not.toBeInTheDocument();
    const choice = screen.getByRole('checkbox', {
      name: 'Suggest Slack gateway messaging to my teammate',
    });
    const card = within(choice.closest<HTMLElement>('.ant-card')!);
    expect(card.getAllByRole('checkbox')).toHaveLength(1);
    expect(card.queryByText(/Slack MCP/)).not.toBeInTheDocument();
    expect(card.queryByRole('button')).not.toBeInTheDocument();
    expect(card.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Slack MCP' })).not.toBeInTheDocument();
    expect(screen.getByTestId('gateway-intent')).toHaveTextContent('prefer-existing');
    expect(api.client.service('gateway-channels').create).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
  });
  it('fails closed on unavailable inventory and allows a fresh retry', async () => {
    const api = apiFor([existing]);
    vi.mocked(api.client.service('gateway-channels').findAll).mockRejectedValueOnce(
      new Error('Disconnected')
    );
    render(<Harness api={api} />);
    await screen.findByText('Could not check Slack gateways');
    await screen.findByText('Token required');
    expect(
      screen.queryByRole('checkbox', { name: /create a new Slack gateway/ })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/Prefer your existing Slack gateway: Team bot/);
  });
  it.each(['identity', 'tenant-generation', 'cancel'] as const)(
    'discards PAT and prevents a stale connect after %s during installation',
    async (change) => {
      const api = apiFor();
      const connected = vi.fn();
      const result = await api.connect();
      api.connect.mockClear();
      let resolve!: (value: typeof result) => void;
      api.connect.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
      const view = render(<Harness api={api} onConnected={connected} />);
      const drawer = await openTool('GitHub');
      await userEvent.fill(
        await drawer.findByPlaceholderText('Paste your GitHub bearer access token'),
        'test-only-private-pat'
      );
      await userEvent.click(
        drawer.getByRole('checkbox', { name: 'I understand what this server can access' })
      );
      await userEvent.click(drawer.getByRole('button', { name: 'Connect' }));
      await waitFor(() => expect(api.connect).toHaveBeenCalledOnce());
      if (change === 'cancel') await userEvent.click(drawer.getByRole('button', { name: 'Close' }));
      else
        view.rerender(
          <Harness
            api={api}
            generation={change === 'tenant-generation' ? 2 : 1}
            user={change === 'identity' ? ({ ...admin, user_id: 'bob' } as User) : admin}
          />
        );
      resolve(result);
      await waitFor(() =>
        expect(screen.queryByPlaceholderText(/bearer access token/)).not.toBeInTheDocument()
      );
      expect(connected).not.toHaveBeenCalled();
      expect(api.client.service('mcp-catalog/start-session').create).not.toHaveBeenCalled();
      const reopened = await openTool('GitHub');
      expect(await reopened.findByPlaceholderText(/bearer access token/)).toHaveValue('');
      expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(
        'test-only-private-pat'
      );
    }
  );
  it.each([false, true])(
    'keeps OAuth pending until durable attempt AND caller credential confirmation, then returns in context (retry: %s)',
    async (retry) => {
      const api = apiFor([], true);
      const onConnected = vi.fn();
      const popup = {
        opener: null,
        document: { title: '', body: { textContent: '' } },
        closed: false,
        location: { replace: vi.fn() },
        close: vi.fn(),
      };
      vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
      vi.mocked(api.client.service('mcp-catalog/readiness').get).mockResolvedValue({
        catalog_key: oauthEntry.name,
        state: 'oauth_required',
      } as never);
      const base = await api.connect();
      api.connect.mockClear();
      api.connect.mockResolvedValue({
        ...base,
        mcp_server: { ...base.mcp_server, auth: { type: 'oauth' } },
      } as never);
      vi.mocked(api.client.service('mcp-servers/oauth-start').create).mockResolvedValue({
        success: true,
        authorizationUrl: 'https://accounts.example.test/authorize',
        attempt_id: 'attempt-1',
      } as never);
      if (retry)
        vi.mocked(api.client.service('mcp-servers/oauth-start').create).mockRejectedValueOnce(
          new Error('secret-provider-response-do-not-display')
        );
      const status = vi.mocked(api.client.service('mcp-servers/oauth-attempt-status').get);
      status.mockResolvedValue({ status: 'pending', mcp_server_id: 'server-1' } as never);
      render(<Harness api={api} onConnected={onConnected} />);
      const drawer = await openTool('Linear');
      await userEvent.click(
        drawer.getByRole('checkbox', { name: 'I understand what this server can access' })
      );
      await userEvent.click(drawer.getByRole('button', { name: 'Connect' }));
      if (retry) {
        await drawer.findByText('Sign-in not completed');
        expect(screen.queryByText(/secret-provider-response/)).not.toBeInTheDocument();
        expect(onConnected).not.toHaveBeenCalled();
        await userEvent.click(drawer.getByRole('button', { name: 'Retry sign-in' }));
        await userEvent.click(await drawer.findByRole('button', { name: 'Connect' }));
      }
      await drawer.findByText('Sign-in pending');
      expect(drawer.queryByRole('button', { name: /Start.*session/ })).not.toBeInTheDocument();
      expect(drawer.queryByRole('combobox')).not.toBeInTheDocument();
      expect(popup.location.replace).toHaveBeenCalledWith(
        'https://accounts.example.test/authorize'
      );
      expect(onConnected).not.toHaveBeenCalled();
      vi.mocked(api.client.service('mcp-catalog/readiness').get).mockResolvedValue({
        catalog_key: oauthEntry.name,
        state: 'installed_ready',
      } as never);
      status.mockResolvedValue({ status: 'succeeded', mcp_server_id: 'server-1' } as never);
      await drawer.findByText('Connected and ready');
      expect(api.client.service('mcp-catalog/start-session').create).not.toHaveBeenCalled();
      expect(api.client.service('sessions').create).not.toHaveBeenCalled();
      expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(
        'Explain this repository.'
      );
      await waitFor(() => expect(onConnected).toHaveBeenCalledWith('server-1'));
      await userEvent.click(drawer.getByRole('button', { name: 'Return to onboarding' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const row = screen.getByText('Linear').closest<HTMLElement>('.ant-card')!;
      expect(await within(row).findByText('Ready to use')).toBeInTheDocument();
      await waitFor(() =>
        expect(within(row).getByRole('button', { name: /^Sign in through Catalog/ })).toHaveFocus()
      );
    }
  );
});
