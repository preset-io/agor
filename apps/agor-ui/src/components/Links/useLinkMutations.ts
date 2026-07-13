import type { AgorClient, Link } from '@agor-live/client';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useCallback, useRef, useState } from 'react';
import { agorStore } from '../../store/agorStore';
import { useThemedMessage } from '../../utils/message';
import type { LinkDisplayItem } from './linkDisplay';
import { createManualLink, type ManualLinkDraft, updateLinkDisplayItem } from './linkLifecycle';
import { type LinkMoveSelection, moveLinkDisplayItem } from './linkMove';
import { toggleLinkDisplayItemPinned } from './linkPinning';
import {
  formatLinkMutationFailure,
  LINK_BUSY_KEY,
  LINK_MUTATION_FAILURE_PREFIX,
  LINK_MUTATION_MESSAGE,
  LINK_OWNER_SCOPE,
  LINK_SERVICE,
  type LinkOwnerScope,
} from './linkUiConstants';

function startBusy(
  busy: MutableRefObject<Set<string>>,
  setBusy: Dispatch<SetStateAction<ReadonlySet<string>>>,
  key: string
): boolean {
  if (busy.current.has(key)) return false;
  busy.current.add(key);
  setBusy(new Set(busy.current));
  return true;
}

function finishBusy(
  busy: MutableRefObject<Set<string>>,
  setBusy: Dispatch<SetStateAction<ReadonlySet<string>>>,
  key: string
): void {
  busy.current.delete(key);
  setBusy(new Set(busy.current));
}

interface UseLinkMutationsOptions {
  client: AgorClient | null;
  branchId?: string | null;
  sessionId?: string | null;
}

export function useLinkMutations({ client, branchId, sessionId }: UseLinkMutationsOptions) {
  const { showSuccess, showError } = useThemedMessage();
  const [pinningKeys, setPinningKeys] = useState<ReadonlySet<string>>(new Set());
  const [lifecycleBusyKeys, setLifecycleBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const pinningRef = useRef(new Set<string>());
  const lifecycleBusyRef = useRef(new Set<string>());

  const togglePinned = useCallback(
    async (item: LinkDisplayItem) => {
      const key = item.linkId ?? item.key;
      if (!client || !startBusy(pinningRef, setPinningKeys, key)) return;
      try {
        const updated = await toggleLinkDisplayItemPinned({
          client,
          item,
          branchId,
          sessionId,
        });
        const state = agorStore.getState();
        if (item.linkId) state.applyLinkMutationResult(updated);
        else state.applyKnownLinkCreatedResult(updated);
      } catch (error) {
        showError(formatLinkMutationFailure(LINK_MUTATION_FAILURE_PREFIX.pin, error));
      } finally {
        finishBusy(pinningRef, setPinningKeys, key);
      }
    },
    [branchId, client, sessionId, showError]
  );

  const createLink = useCallback(
    async (draft: ManualLinkDraft, ownerScope: LinkOwnerScope): Promise<boolean> => {
      const key = LINK_BUSY_KEY.create(ownerScope);
      if (!client || !startBusy(lifecycleBusyRef, setLifecycleBusyKeys, key)) return false;
      try {
        const created = await createManualLink({
          client,
          branchId: ownerScope === LINK_OWNER_SCOPE.branch ? branchId : null,
          sessionId: ownerScope === LINK_OWNER_SCOPE.session ? sessionId : null,
          draft,
        });
        agorStore.getState().applyKnownLinkCreatedResult(created);
        showSuccess(LINK_MUTATION_MESSAGE.added);
        return true;
      } catch (error) {
        showError(formatLinkMutationFailure(LINK_MUTATION_FAILURE_PREFIX.add, error));
        return false;
      } finally {
        finishBusy(lifecycleBusyRef, setLifecycleBusyKeys, key);
      }
    },
    [branchId, client, sessionId, showError, showSuccess]
  );

  const updateLink = useCallback(
    async (
      item: LinkDisplayItem,
      changes: { title?: string | null; target?: string }
    ): Promise<boolean> => {
      const key = item.linkId ?? item.key;
      if (!client || !startBusy(lifecycleBusyRef, setLifecycleBusyKeys, key)) return false;
      try {
        const updated = await updateLinkDisplayItem({
          client,
          item,
          branchId,
          sessionId,
          ...changes,
        });
        const state = agorStore.getState();
        if (item.linkId) state.applyLinkMutationResult(updated);
        else state.applyKnownLinkCreatedResult(updated);
        showSuccess(LINK_MUTATION_MESSAGE.updated);
        return true;
      } catch (error) {
        showError(formatLinkMutationFailure(LINK_MUTATION_FAILURE_PREFIX.update, error));
        return false;
      } finally {
        finishBusy(lifecycleBusyRef, setLifecycleBusyKeys, key);
      }
    },
    [branchId, client, sessionId, showError, showSuccess]
  );

  const removeLink = useCallback(
    async (item: LinkDisplayItem): Promise<boolean> => {
      if (!client || !item.linkId) return false;
      const key = item.linkId;
      if (!startBusy(lifecycleBusyRef, setLifecycleBusyKeys, key)) return false;
      try {
        const removed = (await client.service(LINK_SERVICE).remove(item.linkId)) as Link;
        agorStore.getState().applyKnownLinkRemovedResult(removed);
        showSuccess(LINK_MUTATION_MESSAGE.deleted);
        return true;
      } catch (error) {
        showError(formatLinkMutationFailure(LINK_MUTATION_FAILURE_PREFIX.delete, error));
        return false;
      } finally {
        finishBusy(lifecycleBusyRef, setLifecycleBusyKeys, key);
      }
    },
    [client, showError, showSuccess]
  );

  const moveLink = useCallback(
    async (item: LinkDisplayItem, selection: LinkMoveSelection): Promise<boolean> => {
      const key = item.linkId ?? item.key;
      if (!client || !startBusy(lifecycleBusyRef, setLifecycleBusyKeys, key)) return false;
      try {
        const result = await moveLinkDisplayItem({
          client,
          item,
          selection,
          branchId,
          sessionId,
        });
        const state = agorStore.getState();
        state.applyKnownLinkRemovedResult(result.previous_link);
        state.applyKnownLinkCreatedResult(result.link);
        showSuccess(LINK_MUTATION_MESSAGE.moved);
        return true;
      } catch (error) {
        showError(formatLinkMutationFailure(LINK_MUTATION_FAILURE_PREFIX.move, error));
        return false;
      } finally {
        finishBusy(lifecycleBusyRef, setLifecycleBusyKeys, key);
      }
    },
    [branchId, client, sessionId, showError, showSuccess]
  );

  return {
    pinningKeys,
    lifecycleBusyKeys,
    togglePinned,
    createLink,
    updateLink,
    removeLink,
    moveLink,
  };
}
