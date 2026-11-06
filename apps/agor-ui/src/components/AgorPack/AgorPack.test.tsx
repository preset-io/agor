import type { AgorPackImport, AgorPackPreflightTeammate } from '@agor/core/types';
import type { Branch, Schedule } from '@agor-live/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/harness';
import { applyPackImport, exportPack, getPackImport, uploadPack } from '../../utils/agorPack';
import { ExportPackModal } from './ExportPackModal';
import { ExportPackPanel } from './ExportPackPanel';
import { scheduleStateLine } from './FinishSetup';
import { ImportPackSection } from './ImportPackSection';
import { checkFromPreflight, checkFromReceipt } from './packCheck';
import { finishSetupItems } from './useFinishSetup';

const MB = 1024 * 1024;
const ada: AgorPackPreflightTeammate = {
  branch_id: 'b1',
  display_name: 'Ada',
  local_home: true,
  remote_url: null,
  sessions: { own: 20, others: 5, recent_own: 8, recent_others: 1 },
  session_bytes: { own: 40 * MB, others: 10 * MB, recent_own: 12 * MB, recent_others: 2 * MB },
  other_bytes: 3 * MB,
  flagged_sessions: [
    { session_id: 's-recent', title: 'Deploy keys', own: true, recent: true },
    { session_id: 's-old', title: 'Old creds', own: true, recent: false },
  ],
  board: true,
  schedules: 2,
  artifacts: 4,
  knowledge_documents: 12,
  knowledge_outside_links: { count: 2, namespaces: ['shared-docs'] },
  archived: { sessions: 3, knowledge_documents: 1, artifacts: 0 },
  requirements: {
    env_vars: [
      { name: 'SHORTCUT_API_TOKEN', scope: 'global', used_by: ['schedule:Weekly roundup'] },
      { name: 'PERSONAL_ONLY', scope: 'global', used_by: ['user'] },
    ],
    mcp_servers: [
      {
        name: 'notion',
        display_name: 'Notion',
        catalog_entry_name: 'com.notion/mcp',
        url: 'https://mcp.notion.com/mcp',
        custom: false,
        used_by: ['schedule:Morning brief'],
      },
      {
        name: 'jenkins',
        display_name: null,
        catalog_entry_name: null,
        url: 'https://jenkins.internal/mcp',
        custom: true,
        used_by: [],
      },
    ],
    gateway_channels: [{ channel_type: 'slack', name: '#design-crit' }],
    agentic_tools: ['claude-code'],
  },
  environment: {
    variant: 'dev',
    variants: [{ name: 'dev', status: 'wont_run_in_cloud', match: 'docker' }],
  },
  switch_over: null,
  warnings: [],
};

vi.mock('../../utils/agorPack', () => ({
  fetchPackPreflight: vi.fn(async () => [ada]),
  exportPack: vi.fn(async () => ({ filename: 'ada.agor' })),
  uploadPack: vi.fn(),
  applyPackImport: vi.fn(),
  getPackImport: vi.fn(),
}));

const adaBranch = {
  branch_id: 'b1',
  name: 'ada',
  archived: false,
  custom_context: { teammate: { kind: 'teammate', displayName: 'Ada', emoji: '🦊' } },
} as unknown as Branch;

describe('Check report data', () => {
  it('counts what moves for a history choice and leaves flagged sessions out', () => {
    const check = checkFromPreflight([ada], 'last_90_days', false, true);
    expect(check.counts).toEqual({
      teammates: 1,
      boards: 1,
      artifacts: 4,
      docs: 12,
      schedules: 2,
      sessions: 7,
    });
    expect(check.flagged.map((s) => s.session_id)).toEqual(['s-recent']);
    expect(checkFromPreflight([ada], 'all', true, false).counts.sessions).toBe(25);
    expect(check.reconnect).toEqual([
      'Claude account',
      'Notion',
      'jenkins',
      'Slack',
      'SHORTCUT_API_TOKEN',
      'PERSONAL_ONLY',
    ]);
    expect(check.wont).toEqual([
      { teammate: 'Ada', kind: 'docker' },
      { teammate: 'Ada', kind: 'host', host: 'jenkins.internal' },
    ]);
  });

  it('reads an uploaded pack the same way', () => {
    const check = checkFromReceipt(receipt, ['t01'], true);
    expect(check.counts).toMatchObject({ teammates: 1, boards: 1, docs: 12, sessions: 2 });
    expect(check.flaggedCount).toBe(1);
  });
});

describe('ExportPackModal', () => {
  it('exports everything with the chosen history, leaving flagged sessions out by default', async () => {
    mount(<ExportPackModal open teammate={adaBranch} onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Export Ada to a file')).toBeInTheDocument();
    expect(within(dialog).getByText('Move Ada')).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(await within(dialog).findByText('8 sessions, 12 MB')).toBeInTheDocument();
    expect(within(dialog).getByText('20 sessions, 40 MB')).toBeInTheDocument();
    expect(within(dialog).getByText('Start fresh')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/1 session may contain a password or API key\./)
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('switch', { name: 'Leave this 1 out' })).toBeChecked();
    expect(within(dialog).getByText('About 15 MB')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /Download/ }));
    await waitFor(() =>
      expect(exportPack).toHaveBeenCalledWith({
        branch_ids: ['b1'],
        sessions: 'last_90_days',
        exclude_session_ids: ['s-recent'],
      })
    );
  });
});

describe('ExportPackPanel', () => {
  it('shows the Check report: counts, reconnect chips, what will not work', async () => {
    mount(<ExportPackPanel teammates={[adaBranch]} initialBranchIds={['b1']} />);
    expect(await screen.findByText('Moves to Agor Cloud')).toBeInTheDocument();
    expect(screen.getByText('Plus each teammate’s memory and skills.')).toBeInTheDocument();
    expect(screen.getByText('Claude account')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ada runs app previews on your server with Docker. Agor Cloud can’t do this yet.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ada uses jenkins.internal, which only works on your network. Agor Cloud can’t reach it.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Ada: 3 archived sessions skipped')).toBeInTheDocument();
    expect(screen.getByText('1 teammate, about 15 MB')).toBeInTheDocument();
    fireEvent.click(screen.getByText('None'));
    expect(screen.getByText('1 teammate, about 3 MB')).toBeInTheDocument();
  });
});

const receipt: AgorPackImport = {
  import_id: '01a1a700-0000-7000-8000-000000000001',
  status: 'staged',
  content_sha256: 'a'.repeat(64),
  error: null,
  created_at: '2026-11-04T00:00:00.000Z',
  applied_at: null,
  results: [],
  dry_run: [
    {
      key: 't01',
      display_name: 'Ada',
      repo_status: 'framework',
      already_imported_branch_id: null,
      warnings: ['Environment "dev" uses docker; it won\'t run in Agor Cloud.'],
    },
  ],
  manifest: {
    format: 'agor-pack',
    version: 1,
    pack_id: '01a1a700-0000-7000-8000-000000000002',
    created_at: '2026-11-04T00:00:00.000Z',
    source: {
      agor_version: '0.30.0',
      instance_label: null,
      exported_by: { user_id: '01a1a700-0000-7000-8000-000000000003', email: null, name: 'Kasia' },
    },
    options: { sections: ['board', 'knowledge'], sessions: 'all', include_others_sessions: false },
    entries: [],
    content_sha256: 'a'.repeat(64),
    teammates: [
      {
        key: 't01',
        display_name: 'Ada',
        emoji: '🦊',
        source_branch_id: '01a1a700-0000-7000-8000-000000000004',
        branch_name: 'ada',
        repo: { slug: 'preset-io/agor-teammate', remote_url: null, local_home: true },
        sections: {
          board: { objects: 4 },
          knowledge: {
            documents: 12,
            history_versions: 0,
            outside_links: { count: 1, namespaces: ['team-wiki'] },
          },
          artifacts: 2,
          schedules: 1,
          claude_memory: null,
          uploads: null,
          sessions: {
            mode: 'all',
            count: 3,
            messages: 9,
            others_included: false,
            redacted_values: 2,
            flagged: 1,
          },
          git: null,
          archived_skipped: { sessions: 3, knowledge_documents: 0, artifacts: 1 },
        },
        requirements: ada.requirements,
        environment: ada.environment,
        warnings: [],
      },
    ],
  },
};

describe('ImportPackSection', () => {
  it('uploads a dropped file, checks it, and imports with flagged sessions left out', async () => {
    vi.mocked(uploadPack).mockResolvedValue(receipt);
    vi.mocked(applyPackImport).mockResolvedValue({ ...receipt, status: 'applying' });
    const { container } = mount(<ImportPackSection selfHosted={false} />);
    expect(screen.getByText('Drop an .agor file here, or browse')).toBeInTheDocument();
    expect(screen.getByText('.agor files up to 2 GB')).toBeInTheDocument();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['zip'], 'ada.agor', { type: 'application/zip' })] },
    });
    expect(await screen.findByText('Check before importing')).toBeInTheDocument();
    expect(screen.getByText('What’s imported')).toBeInTheDocument();
    expect(
      screen.getByText('Passwords, API keys and sign-ins aren’t in the file.')
    ).toBeInTheDocument();
    expect(screen.getByText('Ada: 1 archived artifact skipped')).toBeInTheDocument();
    expect(
      screen.getByText('After you switch over, pause Ada’s schedules on Community Edition.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Import Ada' }));
    await waitFor(() =>
      expect(applyPackImport).toHaveBeenCalledWith(receipt.import_id, {
        teammates: ['t01'],
        board_id: null,
        skip_flagged_sessions: true,
      })
    );
    expect(await screen.findByText('Importing')).toBeInTheDocument();
    expect(
      screen.getByText('You can close this window. The import keeps going.')
    ).toBeInTheDocument();
  });

  it('reopens a receipt from ?import=<id> and retries a stopped import', async () => {
    vi.mocked(getPackImport).mockResolvedValue({
      ...receipt,
      status: 'failed',
      error: 'clone failed',
    });
    vi.mocked(applyPackImport).mockClear();
    mount(<ImportPackSection selfHosted />, {
      route: `/settings/import/?import=${receipt.import_id}`,
    });
    expect(await screen.findByText('clone failed')).toBeInTheDocument();
    expect(
      screen.getByText('Bring in teammates exported from Agor Cloud or another Community Edition.')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(applyPackImport).toHaveBeenCalledTimes(1));
  });
});

describe('Finish setup', () => {
  const items = (done: { claude: boolean; notion: boolean }) =>
    finishSetupItems({
      requirements: ada.requirements,
      branchId: 'b1',
      name: 'Ada',
      user: { env_vars: { SHORTCUT_API_TOKEN: { set: true } } } as never,
      credentialFor: () => done.claude,
      servers: done.notion
        ? [{ mcp_server_id: 'm1', name: 'notion', catalog_entry_name: 'com.notion/mcp' } as never]
        : [],
      authedIds: new Set(),
      channels: [],
    });

  it('lists the Claude account first, what each item is used by, and what is done', () => {
    const list = items({ claude: false, notion: true });
    expect(list.map((item) => [item.label, item.done])).toEqual([
      ['Claude account', false],
      ['Notion', true],
      ['jenkins', false],
      ['SHORTCUT_API_TOKEN', true],
      ['Slack', false],
    ]);
    expect(list[0]?.usedBy).toEqual([
      'Ada can’t reply without it. Set up in your Agor Cloud account.',
    ]);
    expect(list[1]?.usedBy).toEqual(['Used by the Morning brief schedule']);
  });

  it('shows a paused schedule as waiting for its app, then as paused until switch over', () => {
    const schedule = { name: 'Morning brief', enabled: false } as Schedule;
    const waiting = (label: string | null) => ({ waitingFor: () => label });
    expect(scheduleStateLine(schedule, waiting('Notion')).text).toBe('Waiting for Notion');
    expect(scheduleStateLine(schedule, waiting(null)).text).toBe('Paused until you switch over');
    expect(scheduleStateLine({ ...schedule, enabled: true }, waiting(null)).text).toBe('On');
  });
});
