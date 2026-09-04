/**
 * BranchModal — Permissions tab visibility.
 *
 * The permissions tab is a modal-level affordance, not just a rendering detail
 * of PermissionsTab. These tests pin the user-facing tab behavior across
 * admin/owner and partial-RBAC-data cases.
 */

import type { AgorClient, Branch, TeammateConfig, User } from '@agor-live/client';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BranchModal } from './BranchModal';
import { buildTeammateKnowledgePatch } from './tabs/KnowledgeTab';
import {
  makeBranch,
  makeRepo,
  makeStubClient,
  makeTeammateBranch,
  makeUser,
  renderWithApp,
} from './testUtils';

const scheduleTabProps = vi.hoisted(() => vi.fn());
vi.mock('./tabs/ScheduleTab', () => ({
  ScheduleTab: (props: unknown) => {
    scheduleTabProps(props);
    return null;
  },
}));

beforeEach(() => {
  scheduleTabProps.mockClear();
  agorStore.setState({ ...EMPTY_MAPS });
});

afterEach(() => {
  agorStore.setState({ ...EMPTY_MAPS });
});

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
  it('mounts the target editor without a development-preview banner', async () => {
    const owner = makeUser({ user_id: 'user-1', role: 'admin', name: 'Alice' });
    const { client, calls } = makeStubClient({ owners: [owner], users: [owner] });

    renderWithApp(
      <BranchModal
        open
        onClose={() => {}}
        branch={makeBranch({ created_by: owner.user_id })}
        repo={makeRepo()}
        sessions={[]}
        client={client}
        currentUser={owner}
        defaultTab="permissions"
      />
    );

    expect(await screen.findByText('Branch permissions')).toBeInTheDocument();
    expect(screen.queryByText('New permissions · development preview')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Current persisted permissions · legacy model')
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply permissions preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset permissions preview' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(calls.some((call) => ['create', 'patch', 'remove'].includes(call.method))).toBe(false);
  });

  it('supplies other schedule owners from the global store if permission loading fails', async () => {
    const caller = makeUser({ user_id: 'caller', role: 'member' });
    const owner = makeUser({ user_id: 'owner', role: 'member' });
    const userById = new Map([
      [caller.user_id, caller],
      [owner.user_id, owner],
    ]);
    agorStore.setState({ userById });

    renderWithApp(
      <BranchModal
        open={true}
        onClose={() => {}}
        branch={makeBranch()}
        repo={makeRepo()}
        sessions={[]}
        client={makeStubClient({ rbac404: true, users: [] }).client}
        currentUser={caller}
        defaultTab="schedule"
      />
    );

    await waitFor(() => expect(scheduleTabProps).toHaveBeenCalled());
    expect(scheduleTabProps.mock.lastCall?.[0]).toMatchObject({
      currentUser: caller,
      userById,
    });
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

  it('shows Permissions for teammate/legacy branch shapes when the admin owns the branch', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'admin' });

    renderBranchModal({
      branch: makeTeammateBranch(),
      currentUser: seb,
      client: makeStubClient({ owners: [seb], users: [seb] }).client,
    });

    expect(await screen.findByRole('tab', { name: /^teammate$/i })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /permissions/i })).toBeInTheDocument();
  });

  it('builds Knowledge patches against modern custom_context.teammate storage', () => {
    const branch = makeTeammateBranch();
    const kb = {
      primary_namespace_id: 'ns-new',
      primary_namespace_slug: 'new-home',
      memory_path_template: 'memory/{{YYYY-MM-DD}}.md' as const,
      default_visibility: 'private' as const,
      global_access: 'write' as const,
      grants: [],
    };

    expect(buildTeammateKnowledgePatch(branch, kb)).toEqual({
      custom_context: {
        teammate: {
          kind: 'teammate',
          displayName: 'My Teammate',
          emoji: '🤖',
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
          displayName: 'Legacy Teammate',
          emoji: '🤖',
        } as unknown as TeammateConfig,
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

    expect(buildTeammateKnowledgePatch(branch, kb)).toEqual({
      custom_context: {
        teammate: {
          kind: 'teammate',
          displayName: 'Legacy Teammate',
          emoji: '🤖',
          kb,
        },
      },
    });
  });
});
