/**
 * React hook for board CRUD operations
 */

import type { AgorClient, Board, UUID } from '@agor-live/client';
import { useState } from 'react';
import { formatActionError } from '../utils/connectionErrors';
import { useThemedMessage } from '../utils/message';

interface UseBoardActionsResult {
  createBoard: (board: Partial<Board>) => Promise<Board | null>;
  updateBoard: (boardId: UUID, updates: Partial<Board>) => Promise<Board | null>;
  deleteBoard: (boardId: UUID) => Promise<boolean>;
  archiveBoard: (boardId: UUID) => Promise<Board | null>;
  unarchiveBoard: (boardId: UUID) => Promise<Board | null>;
  loading: boolean;
}

export function useBoardActions(client: AgorClient | null): UseBoardActionsResult {
  const [loading, setLoading] = useState(false);
  const { showError } = useThemedMessage();

  const createBoard = async (board: Partial<Board>): Promise<Board | null> => {
    if (!client) return null;

    try {
      setLoading(true);
      const created = await client.service('boards').create(board);
      return created;
    } catch (error) {
      showError(formatActionError('create the board', error, { idempotent: false }));
      return null;
    } finally {
      setLoading(false);
    }
  };

  const updateBoard = async (boardId: UUID, updates: Partial<Board>): Promise<Board | null> => {
    if (!client) return null;

    try {
      setLoading(true);
      const updated = await client.service('boards').patch(boardId, updates);
      return updated;
    } catch (error) {
      showError(formatActionError('update the board', error, { idempotent: true }));
      return null;
    } finally {
      setLoading(false);
    }
  };

  const deleteBoard = async (boardId: UUID): Promise<boolean> => {
    if (!client) return false;

    try {
      setLoading(true);
      await client.service('boards').remove(boardId);
      return true;
    } catch (error) {
      showError(formatActionError('delete the board', error, { idempotent: true }));
      return false;
    } finally {
      setLoading(false);
    }
  };

  const archiveBoard = async (boardId: UUID): Promise<Board | null> => {
    if (!client) return null;

    try {
      setLoading(true);
      const archived = await client.service(`boards/${boardId}/archive`).create({});
      return archived as Board;
    } catch (error) {
      showError(formatActionError('archive the board', error, { idempotent: true }));
      return null;
    } finally {
      setLoading(false);
    }
  };

  const unarchiveBoard = async (boardId: UUID): Promise<Board | null> => {
    if (!client) return null;

    try {
      setLoading(true);
      const unarchived = await client.service(`boards/${boardId}/unarchive`).create({});
      return unarchived as Board;
    } catch (error) {
      showError(formatActionError('unarchive the board', error, { idempotent: true }));
      return null;
    } finally {
      setLoading(false);
    }
  };

  return {
    createBoard,
    updateBoard,
    deleteBoard,
    archiveBoard,
    unarchiveBoard,
    loading,
  };
}
