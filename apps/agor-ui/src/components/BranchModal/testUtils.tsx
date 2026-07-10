import type {
  AgorClient,
  Branch,
  KnowledgeNamespace,
  Link,
  Repo,
  TeammateConfig,
  User,
} from '@agor-live/client';
import { render } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactElement, ReactNode } from 'react';

export function wrapper({ children }: { children: ReactNode }) {
  return <AntApp>{children}</AntApp>;
}

export function renderWithApp(ui: ReactElement) {
  return render(<AntApp>{ui}</AntApp>);
}

export interface ServiceCall {
  service: string;
  method: 'find' | 'create' | 'patch' | 'remove' | 'findAll';
  args: unknown[];
}

export interface StubClientOptions {
  owners?: User[];
  users?: User[];
  effectiveAccess?: unknown;
  rbac404?: boolean;
  groupGrants404?: boolean;
  groupGrants?: unknown[];
  groupGrantsPromise?: Promise<unknown[]>;
  failBranchPatch?: boolean;
  /** Throw a 500-style error on the initial owners.find load. */
  failOwnersFind?: boolean;
  namespaces?: KnowledgeNamespace[];
  links?: Link[];
}

export function makeStubClient(opts: StubClientOptions = {}): {
  client: AgorClient;
  calls: ServiceCall[];
} {
  const owners = [...(opts.owners ?? [])];
  const users = opts.users ?? [];
  const calls: ServiceCall[] = [];

  const client = {
    service(path: string) {
      return {
        async find(args: unknown) {
          calls.push({ service: path, method: 'find', args: [args] });
          if (path === 'branches/:id/owners') {
            if (opts.rbac404) {
              const err = new Error('not found') as Error & { code?: number };
              err.code = 404;
              throw err;
            }
            if (opts.failOwnersFind) {
              const err = new Error('database is down') as Error & { code?: number };
              err.code = 500;
              throw err;
            }
            return owners;
          }
          if (path === 'branches/:id/group-grants' && opts.groupGrants404) {
            const err = new Error('not found') as Error & { code?: number };
            err.code = 404;
            throw err;
          }
          if (path === 'branches/:id/group-grants' && opts.groupGrantsPromise) {
            return opts.groupGrantsPromise;
          }
          if (path === 'branches/:id/group-grants') {
            return opts.groupGrants ?? [];
          }
          if (path === 'branches/:id/effective-access') {
            return opts.effectiveAccess ?? { can: 'session', is_owner: false, source: 'others' };
          }
          if (path === 'kb/namespaces') {
            return opts.namespaces ?? [];
          }
          return [];
        },
        async get(id: string) {
          if (path === 'kb/namespaces') {
            const namespace = opts.namespaces?.find((item) => item.namespace_id === id);
            if (namespace) return namespace;
            const err = new Error('not found') as Error & { code?: number };
            err.code = 404;
            throw err;
          }
          return { id };
        },
        async findAll(args: unknown) {
          calls.push({ service: path, method: 'findAll', args: [args] });
          if (path === 'users') return users;
          if (path === 'links') return opts.links ?? [];
          return [];
        },
        async create(body: unknown, params?: unknown) {
          calls.push({ service: path, method: 'create', args: [body, params] });
          if (path === 'branches/:id/owners') {
            const userId = (body as { user_id: string }).user_id;
            const newUser = users.find((u) => u.user_id === userId);
            if (newUser) owners.push(newUser);
            return newUser ?? { user_id: userId };
          }
          return body;
        },
        async patch(id: string, body: unknown, params?: unknown) {
          calls.push({ service: path, method: 'patch', args: [id, body, params] });
          if (path === 'links') {
            const existing = opts.links?.find((link) => link.link_id === id);
            return { ...existing, ...(body as object), link_id: id };
          }
          if (path === 'branches' && opts.failBranchPatch) {
            throw new Error('daemon exploded');
          }
          return { ...(body as object), branch_id: id };
        },
        async remove(id: string, params?: unknown) {
          calls.push({ service: path, method: 'remove', args: [id, params] });
          if (path === 'branches/:id/owners') {
            const idx = owners.findIndex((o) => o.user_id === id);
            if (idx >= 0) owners.splice(idx, 1);
          }
          return { user_id: id };
        },
      };
    },
  } as unknown as AgorClient;

  return { client, calls };
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1',
    email: 'alice@example.com',
    role: 'admin',
    ...overrides,
  } as unknown as User;
}

export function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'preset-io/agor',
    path: '/tmp/agor',
    ...overrides,
  } as unknown as Repo;
}

export function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'branch-1',
    branch_unique_id: 1,
    name: 'feature/foo',
    repo_id: 'repo-1',
    ref: 'feature/foo',
    path: '/tmp/agor/feature/foo',
    new_branch: true,
    created_at: '2026-06-04T00:00:00.000Z',
    updated_at: '2026-06-04T00:00:00.000Z',
    created_by: 'user-1',
    sessions: [],
    needs_attention: false,
    archived: false,
    board_id: undefined,
    issue_url: undefined,
    pull_request_url: undefined,
    notes: '',
    mcp_server_ids: [],
    others_can: 'session',
    others_fs_access: 'read',
    dangerously_allow_session_sharing: false,
    ...overrides,
  } as unknown as Branch;
}

export function makeTeammateBranch(
  overrides: Partial<Branch> = {},
  configOverrides: Partial<TeammateConfig> = {}
): Branch {
  return makeBranch({
    board_id: 'board-1' as Branch['board_id'],
    custom_context: {
      teammate: {
        kind: 'teammate',
        displayName: 'My Teammate',
        emoji: '🤖',
        ...configOverrides,
      } as TeammateConfig,
    },
    ...overrides,
  });
}
