import type { AgorPackImport } from '@agor/core/types';
import type { Branch } from '@agor-live/client';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/harness';
import { ExportPackModal } from './ExportPackModal';
import { ImportPackWizard } from './ImportPackWizard';

vi.mock('../../utils/agorPack', () => ({
  fetchPackPreflight: vi.fn(async () => [
    {
      branch_id: 'b1',
      display_name: 'Ada',
      local_home: true,
      remote_url: null,
      sessions: { own: 2, others: 1, recent_own: 1, recent_others: 0 },
      schedules: 1,
      artifacts: 1,
      knowledge_documents: 3,
      requirements: {
        env_vars: [{ name: 'LINEAR_API_KEY', scope: 'global', used_by: ['mcp:linear'] }],
        mcp_servers: [],
        gateway_channels: [],
        agentic_tools: ['claude-code'],
      },
      environment: {
        variant: 'dev',
        variants: [{ name: 'dev', status: 'wont_run_in_cloud', match: 'docker' }],
      },
      switch_over: null,
      warnings: ["Some environment variants won't run in Agor Cloud as configured."],
    },
  ]),
  exportPack: vi.fn(),
  uploadPack: vi.fn(),
  applyPackImport: vi.fn(),
  getPackImport: vi.fn(),
}));

const ada = {
  branch_id: 'b1',
  name: 'ada',
  archived: false,
  custom_context: { teammate: { kind: 'teammate', displayName: 'Ada', emoji: '🦊' } },
} as unknown as Branch;

describe('ExportPackModal', () => {
  it('opens with every section checked, no sessions, and the preflight', async () => {
    mount(<ExportPackModal open teammates={[ada]} initialBranchIds={['b1']} onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    for (const label of [
      'Board',
      'Knowledge',
      'Artifacts',
      'Schedules',
      'Claude memory',
      'Attachments',
    ]) {
      expect(within(dialog).getByRole('checkbox', { name: label })).toBeChecked();
    }
    expect(within(dialog).getByRole('radio', { name: 'None' })).toBeChecked();
    expect(
      within(dialog).getByRole('checkbox', { name: /other people's sessions/ })
    ).toBeDisabled();
    await waitFor(() => expect(within(dialog).getByText('LINEAR_API_KEY')).toBeInTheDocument());
    expect(within(dialog).getByText(/dev: won't run in Cloud/)).toBeInTheDocument();
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
    options: { sections: ['board', 'knowledge'], sessions: 'none', include_others_sessions: false },
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
          knowledge: { documents: 12, history_versions: 0 },
          artifacts: 2,
          schedules: 1,
          claude_memory: null,
          uploads: null,
          sessions: null,
          git: null,
        },
        requirements: {
          env_vars: [{ name: 'LINEAR_API_KEY', scope: 'global', used_by: [] }],
          mcp_servers: [],
          gateway_channels: [],
          agentic_tools: [],
        },
        environment: { variant: null, variants: [] },
        warnings: [],
      },
    ],
  },
};

describe('ImportPackWizard', () => {
  it('renders the dry-run review from a staged pack', async () => {
    mount(
      <ImportPackWizard open onClose={vi.fn()} boardById={new Map()} initialReceipt={receipt} />
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Exported from Agor 0.30.0 by Kasia/)).toBeInTheDocument();
    expect(within(dialog).getByText(/12 docs · 2 artifacts · 1 schedules/)).toBeInTheDocument();
    expect(within(dialog).getByText('teammate framework')).toBeInTheDocument();
    expect(within(dialog).getByText(/uses docker/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import 1 teammate' })).toBeEnabled();
  });
});
