import { type AgorClient, isTeammatePromotionLink, type Link } from '@agor-live/client';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useCallback, useRef, useState } from 'react';
import { agorStore } from '../../store/agorStore';
import { useThemedMessage } from '../../utils/message';
import type { LinkDisplayItem } from './linkDisplay';
import { toggleLinkDisplayItemPinned } from './linkPinning';
import { promoteLinkToTeammate } from './linkPromotion';

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
  const pinningRef = useRef(new Set<string>());
  const teammateBusyRef = useRef(new Set<string>());

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
        showError(
          `Failed to update pin: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        finishBusy(pinningRef, setPinningKeys, key);
      }
    },
    [branchId, client, sessionId, showError]
  );

  const promoteToTeammate = useCallback(
    async (item: LinkDisplayItem) => {
      if (
        !client ||
        !teammateBranchId ||
        !item.linkId ||
        !startBusy(teammateBusyRef, setTeammateBusyKeys, item.linkId)
      )
        return;
      try {
        const promoted = await promoteLinkToTeammate({
          client,
          sourceLinkId: item.linkId,
          teammateBranchId,
        });
        agorStore.getState().applyKnownLinkCreatedResult(promoted);
        showSuccess(
          isTeammatePromotionLink(promoted)
            ? 'Promoted to teammate'
            : 'Already available on teammate'
        );
      } catch (error) {
        showError(
          `Failed to promote link: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        finishBusy(teammateBusyRef, setTeammateBusyKeys, item.linkId);
      }
    },
    [client, showError, showSuccess, teammateBranchId]
  );

  const removeFromTeammate = useCallback(
    async (item: LinkDisplayItem, teammateLinkId: string) => {
      const key = item.linkId ?? item.key;
      const teammateLink = agorStore.getState().linkById.get(teammateLinkId);
      if (!teammateLink || !isTeammatePromotionLink(teammateLink)) {
        showError('Only links created by teammate promotion can be removed');
        return;
      }
      if (!client || !startBusy(teammateBusyRef, setTeammateBusyKeys, key)) return;
      try {
        const removed = (await client.service('links').remove(teammateLinkId)) as Link;
        agorStore.getState().applyKnownLinkRemovedResult(removed);
        showSuccess('Removed from teammate');
      } catch (error) {
        showError(
          `Failed to remove teammate link: ${error instanceof Error ? error.message : String(error)}`
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
    togglePinned,
    promoteToTeammate,
    removeFromTeammate,
  };
}
