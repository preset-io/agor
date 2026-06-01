import type { AgorClient, BoardID } from '@agor-live/client';
import { useEffect } from 'react';

interface UseBoardPresenceRoomOptions {
  client: AgorClient | null;
  boardId: BoardID | null;
  enabled?: boolean;
}

/**
 * Join the board-scoped cursor room while a board-local cursor consumer is
 * mounted. This keeps high-frequency cursor broadcasts off sockets that are
 * not actively rendering that board.
 */
export function useBoardPresenceRoom(options: UseBoardPresenceRoomOptions) {
  const { client, boardId, enabled = true } = options;

  useEffect(() => {
    if (!enabled || !client?.io || !boardId) return;

    const joinRoom = () => {
      client.io.emit('presence:watch-board', boardId);
    };

    joinRoom();
    client.io.on('connect', joinRoom);
    client.on('authenticated', joinRoom);

    return () => {
      client.io.off('connect', joinRoom);
      client.off('authenticated', joinRoom);
      client.io.emit('presence:unwatch-board', boardId);
    };
  }, [boardId, client, enabled]);
}
