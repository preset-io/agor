/**
 * BranchModal — Permissions tab visibility.
 *
 * The permissions tab is a modal-level affordance, not just a rendering detail
 * of PermissionsTab. These tests pin the user-facing tab behavior across
 * admin/owner and partial-RBAC-data cases.
 */

import type { AgorClient, AssistantConfig, Branch, Link, User } from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BranchModal } from './BranchModal';
import { buildAssistantKnowledgePatch } from './tabs/KnowledgeTab';
import {
  makeAssistantBranch,
  makeBranch,
  makeRepo,
  makeStubClient,
  makeUser,
  renderWithApp,
} from './testUtils';

function makeLink(overrides: Partial<Link> = {}): Link {
  return {
    link_id: 'link-1',
    branch_id: 'branch-1',
    session_id: null,
    source_message_id: null,
    kind: 'url',
    source: 'manual',
    url: 'https://example.com/runbook',
    ref_uri: null,
    file_path: null,
    target_key: 'url:https://example.com/runbook',
    is_pinned: false,
    title: 'Runbook',
    mime_type: null,
    metadata: null,
    created_by: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as Link;
}

function renderBranchModal({
  branch = makeBranch(),
  currentUser,
  client,
}: {
  branch?: Branch;
  currentUser: User;
  client: AgorClient;
}) {
  return renderWithApp(
    <BranchModal
      open={true}
      onClose={() => {}}
      branch={branch}
      repo={makeRepo()}
      sessions={[]}
      client={client}
      currentUser={currentUser}
    />
  );
}

describe('BranchModal — permissions tab visibility', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('shows Permissions for an admin user who is a branch owner', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'admin' });

    renderBranchModal({
      currentUser: seb,
      client: makeStubClient({ owners: [seb], users: [seb] }).client,
    });

    expect(await screen.findByRole('tab', { name: /permissions/i })).toBeInTheDocument();
  });

  it('shows Permissions for an admin even when owner/group metadata is incomplete', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'admin' });

    renderBranchModal({
      currentUser: seb,
      client: makeStubClient({ owners: [], users: [seb], groupGrants404: true }).client,
    });

    expect(await screen.findByRole('tab', { name: /permissions/i })).toBeInTheDocument();
  });

  it('hides Permissions for a non-owner non-admin after owners load', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'member' });
    const owner = makeUser({ user_id: 'owner', role: 'member', email: 'owner@example.com' });

    renderBranchModal({
      currentUser: seb,
      client: makeStubClient({ owners: [owner], users: [seb, owner] }).client,
    });

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /permissions/i })).not.toBeInTheDocument();
    });
  });

  it('shows Permissions for assistant/agent branch shapes when the admin owns the branch', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'admin' });

    renderBranchModal({
      branch: makeAssistantBranch(),
      currentUser: seb,
      client: makeStubClient({ owners: [seb], users: [seb] }).client,
    });

    expect(await screen.findByRole('tab', { name: /assistant/i })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /permissions/i })).toBeInTheDocument();
  });

  it('builds Knowledge patches against modern custom_context.assistant storage', () => {
    const branch = makeAssistantBranch();
    const kb = {
      primary_namespace_id: 'ns-new',
      primary_namespace_slug: 'new-home',
      memory_path_template: 'memory/{{YYYY-MM-DD}}.md' as const,
      default_visibility: 'private' as const,
      global_access: 'write' as const,
      grants: [],
    };

    expect(buildAssistantKnowledgePatch(branch, kb)).toEqual({
      custom_context: {
        assistant: {
          kb,
        },
      },
    });
  });

  it('builds Knowledge patches against legacy custom_context.agent storage', () => {
    const branch = makeBranch({
      custom_context: {
        agent: {
          kind: 'assistant',
          displayName: 'Legacy Assistant',
          emoji: '🤖',
        } as AssistantConfig,
      },
    });
    const kb = {
      primary_namespace_id: 'ns-new',
      primary_namespace_slug: 'new-home',
      memory_path_template: 'memory/{{YYYY-MM-DD}}.md' as const,
      default_visibility: 'private' as const,
      global_access: 'write' as const,
      grants: [],
    };

    expect(buildAssistantKnowledgePatch(branch, kb)).toEqual({
      custom_context: {
        agent: {
          kb,
        },
      },
    });
  });

  it('hydrates the Links tab through the centralized full branch action and renders selector data', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'admin' });
    const link = makeLink();
    const { client, calls } = makeStubClient({ owners: [seb], users: [seb], links: [link] });

    renderBranchModal({
      currentUser: seb,
      client,
    });

    fireEvent.click(await screen.findByRole('tab', { name: /links/i }));

    await screen.findByText('Runbook');
    const linkFind = calls.find((call) => call.service === 'links' && call.method === 'findAll');
    expect(linkFind?.args[0]).toMatchObject({
      query: {
        owner_scope: 'branch',
        branch_id: 'branch-1',
      },
    });
    expect(agorStore.getState().linksByBranch.get('branch-1')).toEqual([link]);
  });
});
