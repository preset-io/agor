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
  prepare = async () => 'branch-1',
  onConnected = vi.fn(),
}: {
  api: ReturnType<typeof apiFor>;
  user?: User;
  generation?: number;
  prepare?: () => Promise<string>;
  onConnected?: (id: string) => void;
}) {
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
            isSelected={() => true}
            onToggle={() => {}}
            prepareBranch={prepare}
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
  it('prefers the usable existing gateway without exposing duplicate creation', async () => {
    const api = apiFor([existing]);
    render(<Harness api={api} />);
    await screen.findByText(/Prefer your existing Slack gateway: Team bot/);
    expect(
      screen.queryByRole('checkbox', { name: /create a new Slack gateway/ })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('gateway-intent')).toHaveTextContent('prefer-existing');
    expect(api.connect).not.toHaveBeenCalled();
  });
  it('exposes new-gateway intent only for an authorized admin, never creates one on selection', async () => {
    const api = apiFor();
    render(<Harness api={api} />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: /create a new Slack gateway/ })
    );
    expect(screen.getByTestId('gateway-intent')).toHaveTextContent('request-new');
    expect(api.client.service('gateway-channels').create).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
  });
  it('denies new-gateway intent to a member and explains unavailable Slack MCP without generic registration', async () => {
    const api = apiFor();
    render(<Harness api={api} user={catalogUser} />);
    await screen.findByText(/An administrator must create one/);
    expect(
      screen.queryByRole('checkbox', { name: /create a new Slack gateway/ })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Slack MCP availability' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Slack MCP' }));
    await drawer.findByText('Slack MCP is not currently available in Catalog');
    expect(drawer.queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.click(drawer.getByRole('button', { name: 'Return to onboarding' }));
    expect(api.connect).not.toHaveBeenCalled();
  });
  it('fails closed on unavailable inventory and allows a fresh retry', async () => {
    const api = apiFor([existing]);
    vi.mocked(api.client.service('gateway-channels').findAll).mockRejectedValueOnce(
      new Error('Disconnected')
    );
    render(<Harness api={api} />);
    await screen.findByText('Could not check Slack gateways');
    expect(
      screen.queryByRole('checkbox', { name: /create a new Slack gateway/ })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/Prefer your existing Slack gateway: Team bot/);
  });
  it.each(['identity', 'tenant-generation', 'cancel'] as const)(
    'discards PAT and prevents a stale connect after %s during preparation',
    async (change) => {
      const api = apiFor();
      let resolve!: (branch: string) => void;
      const prepare = vi.fn(
        () =>
          new Promise<string>((done) => {
            resolve = done;
          })
      );
      const view = render(<Harness api={api} prepare={prepare} />);
      const drawer = await openTool('GitHub');
      await userEvent.fill(
        await drawer.findByPlaceholderText('Paste your GitHub bearer access token'),
        'test-only-private-pat'
      );
      await userEvent.click(
        drawer.getByRole('checkbox', { name: 'I understand what this server can access' })
      );
      await userEvent.click(drawer.getByRole('button', { name: /Verify key & connect/ }));
      await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      if (change === 'cancel') await userEvent.click(drawer.getByRole('button', { name: 'Close' }));
      else
        view.rerender(
          <Harness
            api={api}
            prepare={prepare}
            generation={change === 'tenant-generation' ? 2 : 1}
            user={change === 'identity' ? ({ ...admin, user_id: 'bob' } as User) : admin}
          />
        );
      resolve('old-tenant-branch');
      await waitFor(() =>
        expect(screen.queryByPlaceholderText(/bearer access token/)).not.toBeInTheDocument()
      );
      expect(api.connect).not.toHaveBeenCalled();
      const reopened = await openTool('GitHub');
      expect(await reopened.findByPlaceholderText(/bearer access token/)).toHaveValue('');
      expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(
        'test-only-private-pat'
      );
    }
  );
  it('keeps OAuth pending until durable attempt AND caller credential confirmation, then returns in context', async () => {
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
    const status = vi.mocked(api.client.service('mcp-servers/oauth-attempt-status').get);
    status.mockResolvedValue({ status: 'pending', mcp_server_id: 'server-1' } as never);
    render(<Harness api={api} onConnected={onConnected} />);
    const drawer = await openTool('Linear');
    await userEvent.click(
      drawer.getByRole('checkbox', { name: 'I understand what this server can access' })
    );
    await userEvent.click(drawer.getByRole('button', { name: /Connect with Linear/ }));
    await drawer.findByText('Sign-in pending');
    expect(popup.location.replace).toHaveBeenCalledWith('https://accounts.example.test/authorize');
    expect(onConnected).not.toHaveBeenCalled();
    status.mockResolvedValue({ status: 'succeeded', mcp_server_id: 'server-1' } as never);
    await drawer.findByText('Connected and ready');
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('server-1'));
    await userEvent.click(drawer.getByRole('button', { name: 'Return to onboarding' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
