import type { AgorClient, CapabilityPolicyDraft, User } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBoardsSharedWithMe } from './useBoardsSharedWithMe';

const ME = 'me';
const superadmin = { user_id: ME, name: 'Kasia', role: 'superadmin' } as User;

type Entry = { user?: string; group?: string; capabilities: string[] };

const policy = (
  sharing: 'shared' | 'private',
  entries: Entry[] = [],
  others: string[] = []
): CapabilityPolicyDraft =>
  ({
    schema_version: 1,
    policy_kind: 'board_access',
    sharing_mode: sharing,
    entries: entries.map((entry, i) => ({
      entry_id: `e${i}`,
      principal: entry.user
        ? { principal_type: 'user', user_id: entry.user }
        : { principal_type: 'group', group_id: entry.group },
      preset: entry.capabilities.length ? 'viewer' : 'none',
      capabilities: entry.capabilities,
      fs_access: 'none',
    })),
    others: { preset: others.length ? 'viewer' : 'none', capabilities: others, fs_access: 'none' },
  }) as unknown as CapabilityPolicyDraft;

const VIEW = ['board.view'];

/** Boards keyed by id; the caller belongs to `crew` and to the archived `old-crew`. */
function clientFor(
  boards: Record<string, { owner?: string; board_access: CapabilityPolicyDraft }>,
  permissionsFind?: (id: string) => Promise<unknown>
) {
  const find =
    permissionsFind ??
    (async (id: string) => ({
      primary_owner_user_id: boards[id].owner ?? 'owner-1',
      board_access: boards[id].board_access,
    }));
  return {
    service: (name: string) => {
      if (name === 'boards/:id/permissions')
        return { find: ({ route }: { route: { id: string } }) => find(route.id) };
      if (name === 'group-memberships')
        return {
          findAll: async () => [
            { group_id: 'crew', user_id: ME },
            { group_id: 'old-crew', user_id: ME },
          ],
        };
      if (name === 'groups')
        return { findAll: async () => [{ group_id: 'crew', archived: false }] };
      throw new Error(`unexpected service ${name}`);
    },
  } as unknown as AgorClient;
}

describe('useBoardsSharedWithMe', () => {
  it('resolves superadmin board access through the board policy, not the role', async () => {
    const client = clientFor({
      owned: { owner: ME, board_access: policy('private') },
      'group-grant': { board_access: policy('shared', [{ group: 'crew', capabilities: VIEW }]) },
      'archived-group': {
        board_access: policy('shared', [{ group: 'old-crew', capabilities: VIEW }]),
      },
      'someone-else': {
        board_access: policy('shared', [{ user: 'other', capabilities: VIEW }]),
      },
      'explicit-none': {
        board_access: policy('shared', [{ user: ME, capabilities: [] }], VIEW),
      },
      everyone: { board_access: policy('shared', [], VIEW) },
    });
    const ids = [
      'owned',
      'group-grant',
      'archived-group',
      'someone-else',
      'explicit-none',
      'everyone',
    ];
    const { result } = renderHook(() => useBoardsSharedWithMe(client, superadmin, ids));
    await waitFor(() => expect(result.current('owned')).toBe(true));
    await waitFor(() => expect(result.current('group-grant')).toBe(true));
    expect(result.current('everyone')).toBe(true);
    expect(result.current('archived-group')).toBe(false);
    expect(result.current('someone-else')).toBe(false);
    expect(result.current('explicit-none')).toBe(false);
  });

  it('skips policy reads for everyone else, whose board lists are already scoped', () => {
    const client = clientFor({});
    const find = vi.spyOn(client, 'service');
    const member = { ...superadmin, role: 'member' } as User;
    const { result } = renderHook(() => useBoardsSharedWithMe(client, member, ['any']));
    expect(result.current('any')).toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  it('fails closed on a failed read and reads again on the next mount', async () => {
    const find = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ primary_owner_user_id: ME, board_access: policy('private') });
    const client = clientFor({}, find);
    const first = renderHook(() => useBoardsSharedWithMe(client, superadmin, ['b']));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    expect(first.result.current('b')).toBe(false);
    first.unmount();

    const second = renderHook(() => useBoardsSharedWithMe(client, superadmin, ['b']));
    await waitFor(() => expect(second.result.current('b')).toBe(true));
    expect(find).toHaveBeenCalledTimes(2);
  });
});
