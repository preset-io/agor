/**
 * BranchModal — Permissions tab visibility.
 *
 * The permissions tab is a modal-level affordance, not just a rendering detail
 * of PermissionsTab. These tests pin the user-facing tab behavior across
 * admin/owner and partial-RBAC-data cases.
 */

import type { AgorClient, AssistantConfig, Branch, User } from '@agor-live/client';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
});
