import type { AgorCloudLinkStatus, AgorPackImport } from '@agor/core/types';
import type { Branch, User } from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/harness';
import {
  applyCloudTransfer,
  completeCloudLink,
  exportPack,
  getCloudLink,
  startCloudLink,
  startCloudTransfer,
} from '../../utils/agorPack';
import { MoveToCloudSection } from './MoveToCloudSection';

vi.mock('../../utils/agorPack', () => ({
  fetchPackPreflight: vi.fn(async () => []),
  exportPack: vi.fn(),
  switchOverTeammate: vi.fn(),
  getCloudLink: vi.fn(),
  startCloudLink: vi.fn(),
  completeCloudLink: vi.fn(),
  disconnectCloudLink: vi.fn(),
  startCloudTransfer: vi.fn(),
  getCloudTransfer: vi.fn(),
  applyCloudTransfer: vi.fn(),
}));

const WORKSPACE = 'https://acme.dp-us1a.agor.cloud';
const member = { user_id: 'u1', role: 'member', email: 'ada@example.test' } as unknown as User;
const teammate = (branch_id: string, created_by: string, displayName: string) =>
  ({
    branch_id,
    name: displayName.toLowerCase(),
    archived: false,
    created_by,
    custom_context: { teammate: { kind: 'teammate', displayName } },
  }) as unknown as Branch;
const branches = new Map([
  ['b1', teammate('b1', 'u1', 'Ada')],
  ['b2', teammate('b2', 'someone-else', 'Bea')],
]);
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
const receipt = {
  import_id: 'imp-1',
  status: 'staged',
  content_sha256: 'a'.repeat(64),
  error: null,
  created_at: '2026-11-05T00:00:00.000Z',
  applied_at: null,
  results: [],
  dry_run: [
    {
      key: 't01',
      display_name: 'Ada',
      repo_status: 'framework',
      already_imported_branch_id: null,
      warnings: [],
    },
  ],
  manifest: {
    teammates: [
      {
        key: 't01',
        display_name: 'Ada',
        emoji: null,
        source_branch_id: 'b1',
        repo: { slug: 'preset-io/agor-teammate' },
        sections: { board: { objects: 1 } },
        requirements: { env_vars: [], mcp_servers: [], gateway_channels: [], agentic_tools: [] },
      },
    ],
  },
} as unknown as AgorPackImport;

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('MoveToCloudSection', () => {
  it('starts the Cloud sign-in from the current settings URL', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedOut);
    vi.mocked(startCloudLink).mockReturnValue(new Promise(() => undefined));
    window.history.replaceState(null, '', '/settings/move-to-cloud');
    mount(<MoveToCloudSection currentUser={member} branchById={branches} />);
    fireEvent.click(await screen.findByRole('button', { name: /Sign in to Agor Cloud/ }));
    expect(startCloudLink).toHaveBeenCalledWith(`${window.location.origin}/settings/move-to-cloud`);
    expect(screen.getByRole('button', { name: /Download a .agorpack file instead/ })).toBeVisible();
  });

  it('shows the returned workspace host and connects only after a click', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedOut);
    vi.mocked(completeCloudLink).mockResolvedValue(signedIn);
    window.history.replaceState(
      null,
      '',
      `/settings/move-to-cloud#state=s1&launch_code=launch_x&workspace_url=${encodeURIComponent(WORKSPACE)}&workspace_display_name=Acme&team_slug=acme`
    );
    mount(<MoveToCloudSection currentUser={member} branchById={branches} />);
    expect(await screen.findByText('Connect to Acme?')).toBeInTheDocument();
    // The one-time code is off the URL at once.
    expect(window.location.hash).toBe('');
    expect(completeCloudLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Connect to acme.dp-us1a.agor.cloud/ }));
    await waitFor(() =>
      expect(completeCloudLink).toHaveBeenCalledWith({
        state: 's1',
        launch_code: 'launch_x',
        workspace_url: WORKSPACE,
        workspace_display_name: 'Acme',
        team_slug: 'acme',
      })
    );
    expect(await screen.findByText(/Sending to/)).toBeInTheDocument();
  });

  it("doesn't offer a member teammates someone else owns (even ones they created)", async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedIn);
    // Created by this member, but owned by someone else: ownership decides.
    const others = new Map([
      ['b2', { ...teammate('b2', 'u1', 'Bea'), primary_owner_user_id: 'someone-else' } as Branch],
    ]);
    mount(<MoveToCloudSection currentUser={member} branchById={others} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('You have no AI teammates to move yet.')).toBeInTheDocument();
  });

  it('sends a member’s own teammates, reviews, imports, and links the Cloud checklist', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedIn);
    vi.mocked(exportPack).mockResolvedValue({
      export_id: 'e1',
      ref: 'r1',
      size: 10,
      filename: 'ada.agorpack',
      manifest: receipt.manifest,
    });
    vi.mocked(startCloudTransfer).mockResolvedValue({
      transfer_id: 'tr1',
      status: 'staged',
      bytes_sent: 10,
      bytes_total: 10,
      workspace_url: WORKSPACE,
      import: receipt,
    });
    vi.mocked(applyCloudTransfer).mockResolvedValue({
      transfer_id: 'tr1',
      status: 'applied',
      bytes_sent: 10,
      bytes_total: 10,
      workspace_url: WORKSPACE,
      import: { ...receipt, status: 'applied', results: [{ key: 't01' }] } as never,
      open_url: `${WORKSPACE}/ui/settings/teammates?import=imp-1`,
    });
    mount(<MoveToCloudSection currentUser={member} branchById={branches} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect((await screen.findAllByText(/Ada/)).length).toBeGreaterThan(0);
    const send = screen.getByRole('button', { name: /Send to Agor Cloud/ });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() =>
      expect(exportPack).toHaveBeenCalledWith(expect.anything(), { download: false })
    );
    expect(startCloudTransfer).toHaveBeenCalledWith('e1', 'r1');
    // Before the transfer is staged, the review never shows; staged → review → import.
    fireEvent.click(
      await screen.findByRole('button', { name: /Import 1 teammate into Agor Cloud/ })
    );
    expect(applyCloudTransfer).toHaveBeenCalledWith('tr1', ['t01']);
    const open = await screen.findByRole('link', {
      name: /Open reconnect checklist in Agor Cloud/,
    });
    expect(open).toHaveAttribute('href', `${WORKSPACE}/ui/settings/teammates?import=imp-1`);
  });

  it('offers the teammates an earlier import left out', async () => {
    vi.mocked(getCloudLink).mockResolvedValue(signedIn);
    vi.mocked(exportPack).mockResolvedValue({
      export_id: 'e1',
      ref: 'r1',
      size: 10,
      filename: 'team.agorpack',
      manifest: receipt.manifest,
    });
    const two = {
      ...receipt,
      status: 'applied',
      dry_run: [...receipt.dry_run, { ...receipt.dry_run[0], key: 't02', display_name: 'Cy' }],
      manifest: {
        teammates: [
          ...receipt.manifest.teammates,
          { ...receipt.manifest.teammates[0], key: 't02', display_name: 'Cy' },
        ],
      },
      results: [{ key: 't01', branch_id: 'cloud-b1', filesystem: 'ready' }],
    } as unknown as AgorPackImport;
    vi.mocked(startCloudTransfer).mockResolvedValue({
      transfer_id: 'tr1',
      status: 'applied',
      bytes_sent: 10,
      bytes_total: 10,
      workspace_url: WORKSPACE,
      import: two,
      open_url: `${WORKSPACE}/ui/settings/teammates?import=imp-1`,
    });
    vi.mocked(applyCloudTransfer).mockReturnValue(new Promise(() => undefined));
    mount(<MoveToCloudSection currentUser={member} branchById={branches} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const send = await screen.findByRole('button', { name: /Send to Agor Cloud/ });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    expect(await screen.findByText(/1 teammate imported into/)).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole('button', { name: /Import 1 teammate into Agor Cloud/ })
    );
    expect(applyCloudTransfer).toHaveBeenCalledWith('tr1', ['t02']);
  });
});
