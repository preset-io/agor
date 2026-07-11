import type { AgorClient, Link } from '@agor-live/client';
import { useCallback, useRef, useState } from 'react';
import { agorStore } from '../../store/agorStore';
import { useThemedMessage } from '../../utils/message';
import type { LinkDisplayItem } from './linkDisplay';
import { toggleLinkDisplayItemPinned } from './linkPinning';
import { promoteLinkToTeammate } from './linkPromotion';

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
  const [pinningKey, setPinningKey] = useState<string | null>(null);
  const [teammateBusyKey, setTeammateBusyKey] = useState<string | null>(null);
  const pinningRef = useRef(false);
  const teammateBusyRef = useRef(false);

  const togglePinned = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || pinningRef.current) return;
      pinningRef.current = true;
      const key = item.linkId ?? item.key;
      setPinningKey(key);
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
        pinningRef.current = false;
        setPinningKey(null);
      }
    },
    [branchId, client, sessionId, showError]
  );

  const promoteToTeammate = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || !teammateBranchId || !item.linkId || teammateBusyRef.current) return;
      teammateBusyRef.current = true;
      setTeammateBusyKey(item.linkId);
      try {
        const promoted = await promoteLinkToTeammate({
          client,
          sourceLinkId: item.linkId,
          teammateBranchId,
        });
        agorStore.getState().applyKnownLinkCreatedResult(promoted);
        showSuccess('Promoted to teammate');
      } catch (error) {
        showError(
          `Failed to promote link: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        teammateBusyRef.current = false;
        setTeammateBusyKey(null);
      }
    },
    [client, showError, showSuccess, teammateBranchId]
  );

  const removeFromTeammate = useCallback(
    async (_item: LinkDisplayItem, teammateLinkId: string) => {
      if (!client || teammateBusyRef.current) return;
      teammateBusyRef.current = true;
      setTeammateBusyKey(teammateLinkId);
      try {
        const removed = (await client.service('links').remove(teammateLinkId)) as Link;
        agorStore.getState().applyKnownLinkRemovedResult(removed);
        showSuccess('Removed from teammate');
      } catch (error) {
        showError(
          `Failed to remove teammate link: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        teammateBusyRef.current = false;
        setTeammateBusyKey(null);
      }
    },
    [client, showError, showSuccess]
  );

  return {
    pinningKey,
    teammateBusyKey,
    togglePinned,
    promoteToTeammate,
    removeFromTeammate,
  };
}
