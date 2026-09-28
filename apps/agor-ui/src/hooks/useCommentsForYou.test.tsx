import type { AgorClient, BoardComment, User } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EMPTY_MAPS } from '../store/agorMaps';
import { agorStore } from '../store/agorStore';
import { useCommentsForYou } from './useCommentsForYou';

const admin = { user_id: 'me', name: 'Kasia', role: 'superadmin' } as User;
const mention = (id: string, boardId: string) =>
  ({
    comment_id: id,
    board_id: boardId,
    created_by: 'someone',
    content: '@Kasia can you look?',
    resolved: false,
    created_at: new Date().toISOString(),
  }) as unknown as BoardComment;

describe('useCommentsForYou', () => {
  it('leaves out boards a superadmin reaches only by role (the phone bell badge)', async () => {
    agorStore.setState({
      ...EMPTY_MAPS,
      commentById: new Map([
        ['open', mention('open', 'b-open')],
        ['private', mention('private', 'b-private')],
      ]),
    } as never);
    const client = {
      service: () => ({
        find: async ({ route }: { route: { id: string } }) => ({
          primary_owner_user_id: 'other',
          board_access: {
            sharing_mode: route.id === 'b-open' ? 'shared' : 'private',
            entries: [],
          },
        }),
      }),
    } as unknown as AgorClient;
    const { result } = renderHook(() => useCommentsForYou(client, admin));
    await waitFor(() => expect(result.current.map((c) => c.thread.comment_id)).toEqual(['open']));
  });
});
