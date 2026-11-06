import type {
  AgorCloudLinkStatus,
  AgorCloudMove,
  AgorPackPreflightTeammate,
} from '@agor/core/types';
import type { Branch, User } from '@agor-live/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { mount } from '../../test/harness';
import {
  completeCloudLink,
  getCloudLink,
  getCloudMove,
  getLatestCloudMove,
  retryCloudMove,
  startCloudLink,
  startCloudMove,
} from '../../utils/agorPack';
import { MoveToCloudSection } from './MoveToCloudSection';

vi.mock('../../utils/agorPack', () => ({
  fetchPackPreflight: vi.fn(async (ids: string[]) =>
    preflight.filter((t) => ids.includes(t.branch_id))
  ),
  exportPack: vi.fn(),
  switchOverTeammate: vi.fn(),
  getCloudLink: vi.fn(),
  startCloudLink: vi.fn(),
  completeCloudLink: vi.fn(),
  disconnectCloudLink: vi.fn(),
  startCloudMove: vi.fn(),
  getCloudMove: vi.fn(),
  getLatestCloudMove: vi.fn(async () => null),
  retryCloudMove: vi.fn(),
}));

const WORKSPACE = 'https://acme.dp-us1a.agor.cloud';
const member = { user_id: 'u1', role: 'member', email: 'ada@example.test' } as unknown as User;
const teammate = (branch_id: string, created_by: string, displayName: string, extra = {}) =>
  ({
    branch_id,
    name: displayName.toLowerCase(),
    archived: false,
    created_by,
    custom_context: { teammate: { kind: 'teammate', displayName, emoji: '🦉' } },
    ...extra,
  }) as unknown as Branch;
const MB = 1024 * 1024;
const preflight: AgorPackPreflightTeammate[] = [
  {
    branch_id: 'b1',
    display_name: 'Ada',
    local_home: true,
    remote_url: null,
    sessions: { own: 20, others: 0, recent_own: 8, recent_others: 0 },
    session_bytes: { own: 40 * MB, others: 0, recent_own: 12 * MB, recent_others: 0 },
    other_bytes: 3 * MB,
    flagged_sessions: [{ session_id: 's-recent', title: 'Deploy keys', own: true, recent: true }],
    board: true,
    schedules: 2,
    artifacts: 4,
    knowledge_documents: 12,
    knowledge_outside_links: { count: 0, namespaces: [] },
    archived: { sessions: 0, knowledge_documents: 0, artifacts: 0 },
    requirements: {
      env_vars: [],
      mcp_servers: [],
      gateway_channels: [],
      agentic_tools: ['claude-code'],
    },
    environment: { variant: null, variants: [] },
    switch_over: null,
    warnings: [],
  } as unknown as AgorPackPreflightTeammate,
];
const signedOut: AgorCloudLinkStatus = { console_url: 'https://console.agor.cloud', link: null };
const signedIn: AgorCloudLinkStatus = {
  console_url: 'https://console.agor.cloud',
  link: {
    workspace_url: WORKSPACE,
    workspace_display_name: 'Acme',
    team_slug: 'acme',
    cloud_email: 'ada@acme.test',
    linked_at: '2026-11-05T00:00:00.000Z',
  },
};
const move = (status: AgorCloudMove['items'][number]['status'], extra = {}): AgorCloudMove => ({
  move_id: 'm1',
  status: status === 'done' || status === 'failed' ? 'finished' : 'moving',
  workspace_url: WORKSPACE,
  workspace_display_name: 'Acme',
  created_at: '2026-11-06T00:00:00.000Z',
  items: [
    {
      branch_id: 'b1',
      display_name: 'Ada',
      emoji: '🦉',
      status,
      bytes_sent: 5,
      bytes_total: 10,
      ...extra,
    },
  ],
});

beforeEach(() => {
  agorStore.setState({
    branchById: new Map([
      ['b1', teammate('b1', 'u1', 'Ada')],
      // Created by this member, but owned by someone else: ownership decides.
      ['b2', teammate('b2', 'u1', 'Bea', { primary_owner_user_id: 'someone-else' })],
    ]),
  });
});
afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

const dialog = () => screen.findByRole('dialog');

describe('Settings → Agor Cloud', () => {
  it('shows the card with only the teammates this member owns', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedOut);
    mount(<MoveToCloudSection currentUser={member} />);
    expect(await screen.findByText('Agor Cloud runs your teammates for you.')).toBeInTheDocument();
    expect(
      screen.getByText('Teammates keep working when your computer is off')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Your teammates keep running on Community Edition until you switch over.')
    ).toBeInTheDocument();
    expect(screen.getByText(/Ada/)).toBeInTheDocument();
    expect(screen.queryByText(/Bea/)).toBeNull();
  });

  it('opens the sign-in page in a new tab and waits for it', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedOut);
    vi.mocked(startCloudLink).mockResolvedValue({
      authorize_url: 'https://console.agor.cloud/connect/self-hosted?state=s1',
      expires_at: '',
    });
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as never);
    mount(<MoveToCloudSection currentUser={member} />);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Agor Cloud/ }));
    const modal = await dialog();
    // jsdom serves the page over http on localhost: allowed, with a warning.
    expect(within(modal).getByText(/isn’t served over HTTPS/)).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: /Open sign-in page/ }));
    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() =>
      expect(startCloudLink).toHaveBeenCalledWith(
        expect.stringMatching(/^http:\/\/localhost(:\d+)?(\/ui)?\/settings\/move-to-cloud\/$/)
      )
    );
    expect(tab.location.href).toBe('https://console.agor.cloud/connect/self-hosted?state=s1');
    expect(tab.opener).toBeNull();
    expect(
      await within(modal).findByText('Finish signing in on the Agor Cloud tab in your browser.')
    ).toBeInTheDocument();
    // The other tab finishes the sign-in on the daemon.
    vi.mocked(getCloudLink).mockResolvedValue(signedIn);
    expect(
      await within(modal).findByText('Signed in as ada@acme.test', undefined, { timeout: 8000 })
    ).toBeInTheDocument();
    open.mockRestore();
  }, 15_000);

  it('shows the returned workspace host and connects only after a click', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedOut);
    vi.mocked(completeCloudLink).mockResolvedValue(signedIn);
    window.history.replaceState(
      null,
      '',
      `/settings/move-to-cloud/#state=s1&launch_code=launch_x&workspace_url=${encodeURIComponent(WORKSPACE)}&workspace_display_name=Acme&team_slug=acme`
    );
    mount(<MoveToCloudSection currentUser={member} />);
    const modal = await dialog();
    expect(within(modal).getByText(/Only connect if you just started this sign-in/)).toBeVisible();
    // The one-time code is off the URL at once.
    expect(window.location.hash).toBe('');
    expect(completeCloudLink).not.toHaveBeenCalled();
    fireEvent.click(
      within(modal).getByRole('button', { name: /Connect to acme.dp-us1a.agor.cloud/ })
    );
    await waitFor(() =>
      expect(completeCloudLink).toHaveBeenCalledWith({
        state: 's1',
        launch_code: 'launch_x',
        workspace_url: WORKSPACE,
        workspace_display_name: 'Acme',
        team_slug: 'acme',
      })
    );
    expect(await within(modal).findByText('Signed in as ada@acme.test')).toBeInTheDocument();
    expect(within(modal).getByText('acme.dp-us1a.agor.cloud')).toBeInTheDocument();
  });

  it('chooses, checks, moves, and ends on Done with Open Agor Cloud', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedIn);
    vi.mocked(startCloudMove).mockResolvedValue(move('sending'));
    vi.mocked(getCloudMove).mockResolvedValue(
      move('done', { open_url: `${WORKSPACE}/ui/settings/import?import=imp-1` })
    );
    mount(<MoveToCloudSection currentUser={member} />);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Agor Cloud/ }));
    const modal = await dialog();
    fireEvent.click(await within(modal).findByRole('button', { name: 'Continue' }));

    expect(await within(modal).findByText('Choose what to move')).toBeInTheDocument();
    expect(
      within(modal).getByText(
        'Ada, with their memory, skills, boards, artifacts, knowledge and schedules'
      )
    ).toBeInTheDocument();
    expect(await within(modal).findByText('1 teammate, about 15 MB')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: 'Continue' }));

    expect(await within(modal).findByText('Check before moving')).toBeInTheDocument();
    expect(within(modal).getByText('Moves to Agor Cloud')).toBeInTheDocument();
    expect(within(modal).getByText('Claude account')).toBeInTheDocument();
    expect(within(modal).getByText('Leave this 1 out')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: 'Move Ada' }));
    await waitFor(() =>
      expect(startCloudMove).toHaveBeenCalledWith({
        branch_ids: ['b1'],
        sessions: 'last_90_days',
        exclude_session_ids: ['s-recent'],
      })
    );
    expect(await within(modal).findByText('Moving your teammates')).toBeInTheDocument();
    expect(
      within(modal).getByText(
        'You can close this window. Keep your server on until the move is done.'
      )
    ).toBeInTheDocument();

    const done = await screen.findByText('Ada is ready in Agor Cloud', undefined, {
      timeout: 3000,
    });
    expect(done).toBeInTheDocument();
    expect(
      screen.getByText('Ada keeps running on Community Edition until you switch over.')
    ).toBeInTheDocument();
    const doneModal = await dialog();
    // Switch over waits for the Agor Cloud card, after reconnecting in Cloud.
    expect(within(doneModal).queryByRole('button', { name: 'Switch over' })).toBeNull();
    expect(within(doneModal).getByRole('link', { name: /Open Agor Cloud/ })).toHaveAttribute(
      'href',
      `${WORKSPACE}/ui/settings/import?import=imp-1`
    );
  });

  it('reopening shows a running move; a failed teammate can be retried', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedIn);
    vi.mocked(getLatestCloudMove).mockResolvedValue(move('importing'));
    vi.mocked(getCloudMove).mockResolvedValue(move('failed', { error: 'Agor Cloud answered 500' }));
    vi.mocked(retryCloudMove).mockResolvedValue(move('waiting'));
    mount(<MoveToCloudSection currentUser={member} />);
    fireEvent.click(await screen.findByText('Moving your teammates'));
    const modal = await dialog();
    expect(await within(modal).findByText('Moving your teammates')).toBeInTheDocument();
    expect(
      await within(modal).findByText('Agor Cloud answered 500', undefined, { timeout: 3000 })
    ).toBeInTheDocument();
    expect(within(modal).getByText('1 to retry')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retryCloudMove).toHaveBeenCalledWith('m1', 'b1'));
  });

  it('after a reload, reopening shows a finished move for this sign-in; Move more starts over', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedIn);
    vi.mocked(getLatestCloudMove).mockResolvedValue(
      move('done', { open_url: 'https://console.agor.cloud/api/launch-codes/init?x=1' })
    );
    mount(<MoveToCloudSection currentUser={member} />);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Agor Cloud/ }));
    const modal = await dialog();
    expect(await within(modal).findByText('Ada is ready in Agor Cloud')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: 'Move more teammates' }));
    expect(await within(modal).findByText('Choose what to move')).toBeInTheDocument();
  });

  it('stops following a move the daemon lost to a restart (404)', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedIn);
    vi.mocked(getLatestCloudMove).mockResolvedValue(move('sending'));
    vi.mocked(getCloudMove).mockResolvedValue(null);
    mount(<MoveToCloudSection currentUser={member} />);
    fireEvent.click(await screen.findByText('Moving your teammates'));
    const modal = await dialog();
    expect(
      await within(modal).findByText(/Tracking stopped because Agor restarted/, undefined, {
        timeout: 3000,
      })
    ).toBeInTheDocument();
    const calls = vi.mocked(getCloudMove).mock.calls.length;
    expect(within(modal).getByRole('link', { name: /Open Agor Cloud/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/api/launch-codes/init?return_host=acme.dp-us1a.agor.cloud')
    );
    fireEvent.click(within(modal).getByRole('button', { name: 'Move again' }));
    expect(await within(modal).findByText('Choose what to move')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(vi.mocked(getCloudMove).mock.calls.length).toBe(calls);
  });
});
