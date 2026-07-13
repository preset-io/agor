import { type AgorClient, isTeammatePromotionLink, type Link } from '@agor-live/client';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useCallback, useRef, useState } from 'react';
import { agorStore } from '../../store/agorStore';
import { useThemedMessage } from '../../utils/message';
import type { LinkDisplayItem } from './linkDisplay';
import {
  createManualLink,
  type ManualLinkDraft,
  saveLinkToBranch,
  updateLinkDisplayItem,
} from './linkLifecycle';
import { ensurePersistedLink, toggleLinkDisplayItemPinned } from './linkPinning';
import { promoteLinkToTeammate } from './linkPromotion';
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
  teammateBranchId?: string | null;
}

export function useLinkMutations({
  client,
  branchId,
  sessionId,
  teammateBranchId,
}: UseLinkMutationsOptions) {
  const { showSuccess, showError } = useThemedMessage();
  const [pinningKeys, setPinningKeys] = useState<ReadonlySet<string>>(new Set());
  const [teammateBusyKeys, setTeammateBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [lifecycleBusyKeys, setLifecycleBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const pinningRef = useRef(new Set<string>());
  const teammateBusyRef = useRef(new Set<string>());
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

  const promoteToTeammate = useCallback(
    async (item: LinkDisplayItem) => {
      const key = item.linkId ?? item.key;
      if (!client || !teammateBranchId || !startBusy(teammateBusyRef, setTeammateBusyKeys, key))
        return;
      try {
        const source = item.linkId
          ? null
          : await ensurePersistedLink({ client, item, branchId, sessionId, isPinned: false });
        if (source) agorStore.getState().applyKnownLinkCreatedResult(source);
        const promoted = await promoteLinkToTeammate({
          client,
          sourceLinkId: item.linkId ?? String(source?.link_id),
          teammateBranchId,
        });
        agorStore.getState().applyKnownLinkCreatedResult(promoted);
        showSuccess(
          isTeammatePromotionLink(promoted)
            ? LINK_MUTATION_MESSAGE.savedToTeammate
            : LINK_MUTATION_MESSAGE.alreadyOnTeammate
        );
      } catch (error) {
        showError(formatLinkMutationFailure(LINK_MUTATION_FAILURE_PREFIX.saveToTeammate, error));
      } finally {
        finishBusy(teammateBusyRef, setTeammateBusyKeys, key);
      }
    },
    [branchId, client, sessionId, showError, showSuccess, teammateBranchId]
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

  const saveToBranch = useCallback(
    async (item: LinkDisplayItem): Promise<boolean> => {
      const key = item.linkId ?? item.key;
      if (!client || !branchId || !startBusy(lifecycleBusyRef, setLifecycleBusyKeys, key))
        return false;
      try {
        const saved = await saveLinkToBranch({ client, item, branchId });
        agorStore.getState().applyKnownLinkCreatedResult(saved);
        showSuccess(LINK_MUTATION_MESSAGE.savedToBranch);
        return true;
      } catch (error) {
        showError(formatLinkMutationFailure(LINK_MUTATION_FAILURE_PREFIX.save, error));
        return false;
      } finally {
        finishBusy(lifecycleBusyRef, setLifecycleBusyKeys, key);
      }
    },
    [branchId, client, showError, showSuccess]
  );

  const removeFromTeammate = useCallback(
    async (item: LinkDisplayItem, teammateLinkId: string) => {
      const key = item.linkId ?? item.key;
      const teammateLink = agorStore.getState().linkById.get(teammateLinkId);
      if (!teammateLink || !isTeammatePromotionLink(teammateLink)) {
        showError(LINK_MUTATION_MESSAGE.invalidTeammateRemoval);
        return;
      }
      if (!client || !startBusy(teammateBusyRef, setTeammateBusyKeys, key)) return;
      try {
        const removed = (await client.service(LINK_SERVICE).remove(teammateLinkId)) as Link;
        agorStore.getState().applyKnownLinkRemovedResult(removed);
        showSuccess(LINK_MUTATION_MESSAGE.removedFromTeammate);
      } catch (error) {
        showError(
          formatLinkMutationFailure(LINK_MUTATION_FAILURE_PREFIX.removeFromTeammate, error)
        );
      } finally {
        finishBusy(teammateBusyRef, setTeammateBusyKeys, key);
      }
    },
    [client, showError, showSuccess]
  );

  return {
    pinningKeys,
    teammateBusyKeys,
    lifecycleBusyKeys,
    togglePinned,
    createLink,
    updateLink,
    removeLink,
    saveToBranch,
    promoteToTeammate,
    removeFromTeammate,
  };
}
