/**
 * React hook for board CRUD operations
 */

import type { AgorClient, Board, UUID } from '@agor-live/client';
import { useState } from 'react';
import {
  formatActionError,
  isAlreadyDoneError,
  notConnectedMessage,
} from '../utils/connectionErrors';
import { useThemedMessage } from '../utils/message';

interface UseBoardActionsResult {
  createBoard: (board: Partial<Board>) => Promise<Board | null>;
  updateBoard: (boardId: UUID, updates: Partial<Board>) => Promise<Board | null>;
  deleteBoard: (boardId: UUID) => Promise<boolean>;
  archiveBoard: (boardId: UUID) => Promise<boolean>;
  unarchiveBoard: (boardId: UUID) => Promise<boolean>;
  loading: boolean;
}

export function useBoardActions(client: AgorClient | null): UseBoardActionsResult {
  const [loading, setLoading] = useState(false);
  const { showError } = useThemedMessage();
  const notConnected = (action: string) => showError(notConnectedMessage(action));

  const createBoard = async (board: Partial<Board>): Promise<Board | null> => {
    if (!client) {
      notConnected('create the board');
      return null;
    }

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
    if (!client) {
      notConnected('update the board');
      return null;
    }

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
    if (!client) {
      notConnected('delete the board');
      return false;
    }

    try {
      setLoading(true);
      await client.service('boards').remove(boardId);
      return true;
    } catch (error) {
      if (isAlreadyDoneError('delete the board', error)) return true;
      showError(formatActionError('delete the board', error, { idempotent: true }));
      return false;
    } finally {
      setLoading(false);
    }
  };

  const archiveBoard = async (boardId: UUID): Promise<boolean> => {
    if (!client) {
      notConnected('archive the board');
      return false;
    }

    try {
      setLoading(true);
      await client.service(`boards/${boardId}/archive`).create({});
      return true;
    } catch (error) {
      if (isAlreadyDoneError('archive the board', error)) return true;
      showError(formatActionError('archive the board', error, { idempotent: true }));
      return false;
    } finally {
      setLoading(false);
    }
  };

  const unarchiveBoard = async (boardId: UUID): Promise<boolean> => {
    if (!client) {
      notConnected('unarchive the board');
      return false;
    }

    try {
      setLoading(true);
      await client.service(`boards/${boardId}/unarchive`).create({});
      return true;
    } catch (error) {
      if (isAlreadyDoneError('unarchive the board', error)) return true;
      showError(formatActionError('unarchive the board', error, { idempotent: true }));
      return false;
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
