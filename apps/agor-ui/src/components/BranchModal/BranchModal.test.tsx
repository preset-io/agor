/**
 * BranchModal — Permissions tab visibility.
 *
 * The permissions tab is a modal-level affordance, not just a rendering detail
 * of PermissionsTab. These tests pin the user-facing tab behavior across
 * admin/owner and partial-RBAC-data cases.
 */

import type { AgorClient, AssistantConfig, Branch, User } from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BranchModal } from './BranchModal';
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

  it('lets assistant owners change the home Knowledge namespace from the Knowledge tab', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'member' });
    const branch = makeAssistantBranch(
      { created_by: seb.user_id },
      {
        kb: {
          primary_namespace_id: 'ns-old',
          primary_namespace_slug: 'old-home',
          memory_path_template: 'memory/{{YYYY-MM-DD}}.md',
          default_visibility: 'public',
          global_access: 'write',
          grants: [],
        },
      }
    );
    const { client, calls } = makeStubClient({
      owners: [seb],
      users: [seb],
      namespaces: [
        {
          namespace_id: 'ns-old',
          slug: 'old-home',
          display_name: 'Old Home',
          kind: 'branch',
          visibility_default: 'public',
          others_can: 'write',
          effective_permission: 'own',
          created_at: new Date(),
          archived: false,
        },
        {
          namespace_id: 'ns-new',
          slug: 'new-home',
          display_name: 'New Home',
          kind: 'team',
          visibility_default: 'private',
          others_can: 'none',
          effective_permission: 'write',
          created_at: new Date(),
          archived: false,
        },
      ],
    });

    renderBranchModal({ branch, currentUser: seb, client });

    fireEvent.click(await screen.findByRole('tab', { name: /knowledge/i }));
    fireEvent.mouseDown(await screen.findByLabelText(/home knowledge namespace/i));
    fireEvent.click(await screen.findByText(/New Home/));
    fireEvent.click(screen.getByRole('button', { name: /save home/i }));

    await waitFor(() => {
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            service: 'branches',
            method: 'patch',
            args: expect.arrayContaining([
              branch.branch_id,
              expect.objectContaining({
                custom_context: expect.objectContaining({
                  assistant: expect.objectContaining({
                    kb: expect.objectContaining({
                      primary_namespace_id: 'ns-new',
                      primary_namespace_slug: 'new-home',
                      default_visibility: 'private',
                    }),
                  }),
                }),
              }),
            ]),
          }),
        ])
      );
    });
  });

  it('saves Knowledge changes back to legacy custom_context.agent storage', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'member' });
    const branch = makeBranch({
      created_by: seb.user_id,
      board_id: 'board-1' as Branch['board_id'],
      custom_context: {
        agent: {
          kind: 'assistant',
          displayName: 'Legacy Assistant',
          emoji: '🤖',
          kb: {
            primary_namespace_id: 'ns-old',
            primary_namespace_slug: 'old-home',
            memory_path_template: 'memory/{{YYYY-MM-DD}}.md',
            default_visibility: 'public',
            global_access: 'write',
            grants: [],
          },
        } as AssistantConfig,
      },
    });
    const { client, calls } = makeStubClient({
      owners: [seb],
      users: [seb],
      namespaces: [
        {
          namespace_id: 'ns-old',
          slug: 'old-home',
          display_name: 'Old Home',
          kind: 'branch',
          visibility_default: 'public',
          others_can: 'write',
          effective_permission: 'own',
          created_at: new Date(),
          archived: false,
        },
        {
          namespace_id: 'ns-new',
          slug: 'new-home',
          display_name: 'New Home',
          kind: 'team',
          visibility_default: 'private',
          others_can: 'none',
          effective_permission: 'write',
          created_at: new Date(),
          archived: false,
        },
      ],
    });

    renderBranchModal({ branch, currentUser: seb, client });

    fireEvent.click(await screen.findByRole('tab', { name: /knowledge/i }));
    fireEvent.mouseDown(await screen.findByLabelText(/home knowledge namespace/i));
    fireEvent.click(await screen.findByText(/New Home/));
    fireEvent.click(screen.getByRole('button', { name: /save home/i }));

    await waitFor(() => {
      const branchPatchCall = calls.find(
        (call) => call.service === 'branches' && call.method === 'patch'
      );
      expect(branchPatchCall).toBeDefined();
      const patch = branchPatchCall?.args[1] as Partial<Branch> | undefined;
      expect(patch?.custom_context).toEqual({
        agent: {
          kb: expect.objectContaining({
            primary_namespace_id: 'ns-new',
            primary_namespace_slug: 'new-home',
            default_visibility: 'private',
          }),
        },
      });
    });
  });
});
