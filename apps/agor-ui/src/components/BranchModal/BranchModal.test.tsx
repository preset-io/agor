/**
 * BranchModal — Permissions tab visibility.
 *
 * The permissions tab is a modal-level affordance, not just a rendering detail
 * of PermissionsTab. These tests pin the user-facing tab behavior across
 * admin/owner and partial-RBAC-data cases.
 */

import type { AgorClient, AssistantConfig, Branch, Repo, User } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { BranchModal } from './BranchModal';

function renderWithApp(ui: ReactElement) {
  return render(<AntApp>{ui}</AntApp>);
}

interface StubOptions {
  owners?: User[];
  users?: User[];
  groupGrants404?: boolean;
}

function makeStubClient(opts: StubOptions = {}): AgorClient {
  const owners = [...(opts.owners ?? [])];
  const users = opts.users ?? owners;

  return {
    service(path: string) {
      return {
        async find() {
          if (path === 'branches/:id/owners') return owners;
          if (path === 'branches/:id/group-grants') {
            if (opts.groupGrants404) {
              const err = new Error('not found') as Error & { code?: number };
              err.code = 404;
              throw err;
            }
            return [];
          }
          return [];
        },
        async findAll() {
          if (path === 'users') return users;
          if (path === 'groups') return [];
          return [];
        },
        async patch(id: string, body: unknown) {
          return { ...(body as object), branch_id: id };
        },
      };
    },
  } as unknown as AgorClient;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1',
    email: 'alice@example.com',
    role: 'admin',
    ...overrides,
  } as unknown as User;
}

function makeRepo(): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'preset-io/agor',
    path: '/tmp/agor',
  } as unknown as Repo;
}

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'branch-1',
    branch_unique_id: 1,
    name: 'kelly',
    repo_id: 'repo-1',
    ref: 'kelly',
    path: '/tmp/agor/kelly',
    new_branch: true,
    created_at: '2026-06-04T00:00:00.000Z',
    updated_at: '2026-06-04T00:00:00.000Z',
    created_by: 'user-1',
    sessions: [],
    needs_attention: false,
    archived: false,
    mcp_server_ids: [],
    others_can: 'session',
    others_fs_access: 'read',
    dangerously_allow_session_sharing: false,
    ...overrides,
  } as unknown as Branch;
}

function makeAssistantBranch(
  overrides: Partial<Branch> = {},
  configOverrides: Partial<AssistantConfig> = {}
): Branch {
  return makeBranch({
    custom_context: {
      assistant: {
        kind: 'assistant',
        displayName: 'Kelly',
        emoji: '🤖',
        ...configOverrides,
      } as AssistantConfig,
    },
    ...overrides,
  });
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
  it('shows Permissions for an admin user who is a branch owner', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'admin' });

    renderBranchModal({
      currentUser: seb,
      client: makeStubClient({ owners: [seb], users: [seb] }),
    });

    expect(await screen.findByRole('tab', { name: /permissions/i })).toBeInTheDocument();
  });

  it('shows Permissions for an admin even when owner/group metadata is incomplete', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'admin' });

    renderBranchModal({
      currentUser: seb,
      client: makeStubClient({ owners: [], users: [seb], groupGrants404: true }),
    });

    expect(await screen.findByRole('tab', { name: /permissions/i })).toBeInTheDocument();
  });

  it('hides Permissions for a non-owner non-admin after owners load', async () => {
    const seb = makeUser({ user_id: 'seb', role: 'member' });
    const owner = makeUser({ user_id: 'owner', role: 'member', email: 'owner@example.com' });

    renderBranchModal({
      currentUser: seb,
      client: makeStubClient({ owners: [owner], users: [seb, owner] }),
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
      client: makeStubClient({ owners: [seb], users: [seb] }),
    });

    expect(await screen.findByRole('tab', { name: /assistant/i })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /permissions/i })).toBeInTheDocument();
  });
});
