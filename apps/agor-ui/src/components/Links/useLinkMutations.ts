import type { AgorClient, Link } from '@agor-live/client';
import { useCallback, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import {
  selectApplyKnownLinkCreatedResult,
  selectApplyKnownLinkRemovedResult,
  selectApplyLinkMutationResult,
} from '../../store/selectors';
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
  const applyLinkMutationResult = useAgorStore(selectApplyLinkMutationResult);
  const applyKnownLinkCreatedResult = useAgorStore(selectApplyKnownLinkCreatedResult);
  const applyKnownLinkRemovedResult = useAgorStore(selectApplyKnownLinkRemovedResult);
  const [pinningKey, setPinningKey] = useState<string | null>(null);
  const [teammateBusyKey, setTeammateBusyKey] = useState<string | null>(null);

  const togglePinned = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || pinningKey) return;
      const key = item.linkId ?? item.key;
      setPinningKey(key);
      try {
        const updated = await toggleLinkDisplayItemPinned({
          client,
          item,
          branchId,
          sessionId,
        });
        if (item.linkId) applyLinkMutationResult(updated);
        else applyKnownLinkCreatedResult(updated);
      } catch (error) {
        showError(
          `Failed to update pin: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setPinningKey(null);
      }
    },
    [
      applyKnownLinkCreatedResult,
      applyLinkMutationResult,
      branchId,
      client,
      pinningKey,
      sessionId,
      showError,
    ]
  );

  const promoteToTeammate = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || !teammateBranchId || !item.linkId || teammateBusyKey) return;
      setTeammateBusyKey(item.linkId);
      try {
        const promoted = await promoteLinkToTeammate({
          client,
          sourceLinkId: item.linkId,
          teammateBranchId,
        });
        applyKnownLinkCreatedResult(promoted);
        showSuccess('Promoted to teammate');
      } catch (error) {
        showError(
          `Failed to promote link: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setTeammateBusyKey(null);
      }
    },
    [applyKnownLinkCreatedResult, client, showError, showSuccess, teammateBranchId, teammateBusyKey]
  );

  const removeFromTeammate = useCallback(
    async (_item: LinkDisplayItem, teammateLinkId: string) => {
      if (!client || teammateBusyKey) return;
      setTeammateBusyKey(teammateLinkId);
      try {
        const removed = (await client.service('links').remove(teammateLinkId)) as Link;
        applyKnownLinkRemovedResult(removed);
        showSuccess('Removed from teammate');
      } catch (error) {
        showError(
          `Failed to remove teammate link: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setTeammateBusyKey(null);
      }
    },
    [applyKnownLinkRemovedResult, client, showError, showSuccess, teammateBusyKey]
  );

  return {
    pinningKey,
    teammateBusyKey,
    togglePinned,
    promoteToTeammate,
    removeFromTeammate,
  };
}
