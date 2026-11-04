import {
  type AgorClient,
  type ExampleBoardAnalyticsSource,
  PRODUCT_ANALYTICS_EVENTS,
  type User,
} from '@agor-live/client';
import { Button } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ExampleBoardActions } from '../contexts/ExampleBoardContext';
import { agorStore } from '../store/agorStore';
import { isExampleOwned, selectExampleOwnerId } from '../utils/exampleBoard';
import { useThemedMessage } from '../utils/message';
import { useThemedModal } from '../utils/modal';
import { trackProductEvent } from '../utils/productAnalytics';
import { buildBoardPath } from './useUrlState';

const UNDO_KEY = 'example-board-hidden';

interface Options {
  client: AgorClient | null;
  user: User | null | undefined;
  isMobile: boolean;
  /** Opens the onboarding wizard; absent when the person cannot run it. */
  openOnboarding?: () => void;
}

/** Owns "Make your own" and "Hide example" for both shells (provided once at the app root). */
export function useExampleBoardController({
  client,
  user,
  isMobile,
  openOnboarding,
}: Options): ExampleBoardActions {
  const navigate = useNavigate();
  const { confirm } = useThemedModal();
  const { showSuccess, showError, destroy } = useThemedMessage();
  const userId = user?.user_id;
  const storedHidden = user?.preferences?.exampleBoardHidden === true;
  const [hidden, setHidden] = useState(storedHidden);
  useEffect(() => setHidden(storedHidden), [storedHidden]);

  const openBoard = useCallback(
    (boardId: string) =>
      navigate(
        isMobile ? `/m/board/${boardId}` : buildBoardPath(boardId, agorStore.getState().boardById)
      ),
    [navigate, isMobile]
  );

  const setHiddenPreference = useCallback(
    async (next: boolean) => {
      if (!client || !userId) return;
      setHidden(next);
      try {
        const latest = (await client.service('users').get(userId)) as User;
        await client.service('users').patch(userId, {
          preferences: { ...latest.preferences, exampleBoardHidden: next },
        });
      } catch {
        setHidden(!next);
        throw new Error('preference');
      }
    },
    [client, userId]
  );

  const makeYourOwn = useCallback(
    async (source: ExampleBoardAnalyticsSource) => {
      const teammate = await client
        ?.service('users')
        .getPrimaryTeammate()
        .catch(() => null);
      if (teammate?.board_id) {
        trackProductEvent(userId, {
          event: PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_MAKE_YOUR_OWN,
          source,
          destination: 'teammate_board',
        });
        openBoard(teammate.board_id);
        return;
      }
      if (!openOnboarding) return;
      trackProductEvent(userId, {
        event: PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_MAKE_YOUR_OWN,
        source,
        destination: 'onboarding',
      });
      openOnboarding();
    },
    [client, userId, openBoard, openOnboarding]
  );

  const hide = useCallback(() => {
    const state = agorStore.getState();
    const exampleOwnerId = selectExampleOwnerId(state);
    const exampleBoard = [...state.boardById.values()].find((b) =>
      isExampleOwned(b, exampleOwnerId)
    );
    const ownBoard =
      state.boardById.get(String(user?.preferences?.mainBoardId)) ??
      [...state.boardById.values()].find((b) => !b.archived && !isExampleOwned(b, exampleOwnerId));

    const undo = async () => {
      destroy(UNDO_KEY);
      try {
        await setHiddenPreference(false);
      } catch {
        showError("Couldn't bring the example board back. Try again.");
        return;
      }
      trackProductEvent(userId, {
        event: PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_HIDDEN,
        action: 'restored',
      });
      if (exampleBoard) openBoard(exampleBoard.board_id);
    };

    confirm({
      title: 'Hide the example board?',
      content: 'It will be hidden only for you. Nothing is deleted.',
      okText: 'Hide example',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await setHiddenPreference(true);
        } catch {
          showError("Couldn't hide the example board. Try again.");
          return;
        }
        trackProductEvent(userId, {
          event: PRODUCT_ANALYTICS_EVENTS.EXAMPLE_BOARD_HIDDEN,
          action: 'hidden',
        });
        if (ownBoard) openBoard(ownBoard.board_id);
        else navigate(isMobile ? '/m' : '/');
        showSuccess(
          <span>
            Example board hidden.{' '}
            <Button type="link" size="small" onClick={undo} style={{ padding: 0 }}>
              Undo
            </Button>
          </span>,
          { key: UNDO_KEY, duration: 8 }
        );
      },
    });
  }, [
    confirm,
    destroy,
    isMobile,
    navigate,
    openBoard,
    setHiddenPreference,
    showError,
    showSuccess,
    user?.preferences?.mainBoardId,
    userId,
  ]);

  return useMemo(
    () => ({ userId, hidden, hide, makeYourOwn: openOnboarding ? makeYourOwn : undefined }),
    [userId, hidden, hide, makeYourOwn, openOnboarding]
  );
}
