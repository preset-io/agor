import type { AgorClient, Branch, Link } from '@agor-live/client';
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Space, Typography } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../../store/agorStore';
import {
  makeLinksForBranchSelector,
  selectApplyKnownLinkCreatedResult,
  selectApplyKnownLinkRemovedResult,
  selectApplyLinkMutationResult,
  selectBoardById,
  selectFetchAndReplaceFullBranchLinks,
} from '../../../store/selectors';
import { useThemedMessage } from '../../../utils/message';
import {
  buildLinkDisplayItems,
  getAssistantPromotionState,
  getLinkCategorySummary,
  type LinkDisplayItem,
  LinkDisplayList,
  promoteLinkToAssistant,
} from '../../Links';

interface LinksTabProps {
  branch: Branch;
  client: AgorClient | null;
  active: boolean;
  open: boolean;
}

export const LinksTab: React.FC<LinksTabProps> = ({ branch, client, active, open }) => {
  const selector = useMemo(() => makeLinksForBranchSelector(branch.branch_id), [branch.branch_id]);
  const links = useAgorStore(selector) ?? [];
  const boardById = useAgorStore(selectBoardById);
  const fetchAndReplaceFullBranchLinks = useAgorStore(selectFetchAndReplaceFullBranchLinks);
  const applyLinkMutationResult = useAgorStore(selectApplyLinkMutationResult);
  const applyKnownLinkCreatedResult = useAgorStore(selectApplyKnownLinkCreatedResult);
  const applyKnownLinkRemovedResult = useAgorStore(selectApplyKnownLinkRemovedResult);
  const { showError } = useThemedMessage();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pinningLinkId, setPinningLinkId] = useState<string | null>(null);
  const [assistantActionKey, setAssistantActionKey] = useState<string | null>(null);

  const assistantBranchId = branch.board_id
    ? (boardById.get(branch.board_id)?.primary_assistant_id ?? null)
    : null;
  const assistantLinksSelector = useMemo(
    () => makeLinksForBranchSelector(assistantBranchId ?? ''),
    [assistantBranchId]
  );
  const assistantLinks = useAgorStore(assistantLinksSelector) ?? [];

  const displayItems = useMemo(() => buildLinkDisplayItems({ branch, links }), [branch, links]);

  useEffect(() => {
    if (!open || !active || !client) return;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const requests = [fetchAndReplaceFullBranchLinks(client, branch.branch_id)];
    if (assistantBranchId && assistantBranchId !== branch.branch_id) {
      requests.push(fetchAndReplaceFullBranchLinks(client, assistantBranchId));
    }
    Promise.all(requests)
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setLoadError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [active, assistantBranchId, branch.branch_id, client, fetchAndReplaceFullBranchLinks, open]);

  const refresh = async () => {
    if (!client) return;
    setLoading(true);
    setLoadError(null);
    try {
      await fetchAndReplaceFullBranchLinks(client, branch.branch_id);
      if (assistantBranchId && assistantBranchId !== branch.branch_id) {
        await fetchAndReplaceFullBranchLinks(client, assistantBranchId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePinned = async (item: { linkId?: string; isPinned: boolean }) => {
    if (!client || !item.linkId) return;
    setPinningLinkId(item.linkId);
    try {
      const updated = (await client.service('links').patch(item.linkId, {
        is_pinned: !item.isPinned,
      })) as Link;
      applyLinkMutationResult(updated);
    } catch (error) {
      showError(`Failed to update link: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPinningLinkId(null);
    }
  };

  const assistantStateForItem = useCallback(
    (item: LinkDisplayItem) => {
      const state = getAssistantPromotionState({
        item,
        assistantBranchId,
        sourceBranchId: branch.branch_id,
        assistantLinks,
      });
      if (!state.canPromote) return null;
      const actionKey = state.isPromoted ? state.assistantLink.link_id : item.linkId;
      return {
        isPromoted: state.isPromoted,
        assistantLinkId: state.assistantLink?.link_id,
        disabled: !client,
        loading: actionKey ? assistantActionKey === actionKey : false,
      };
    },
    [assistantActionKey, assistantBranchId, assistantLinks, branch.branch_id, client]
  );

  const handlePromoteToAssistant = async (item: LinkDisplayItem) => {
    if (!client || !assistantBranchId || !item.linkId) return;
    setAssistantActionKey(item.linkId);
    try {
      const promoted = await promoteLinkToAssistant({
        client,
        sourceLinkId: item.linkId,
        assistantBranchId,
      });
      applyKnownLinkCreatedResult(promoted);
    } catch (error) {
      showError(
        `Failed to add link to assistant: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setAssistantActionKey(null);
    }
  };

  const handleRemoveFromAssistant = async (_item: LinkDisplayItem, assistantLinkId: string) => {
    if (!client) return;
    setAssistantActionKey(assistantLinkId);
    try {
      const removed = (await client.service('links').remove(assistantLinkId)) as Link;
      applyKnownLinkRemovedResult(removed);
    } catch (error) {
      showError(
        `Failed to remove link from assistant: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setAssistantActionKey(null);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <Card
        title="Links"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={refresh}
            loading={loading}
            disabled={!client}
          >
            Refresh
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {displayItems.length > 0
              ? getLinkCategorySummary(displayItems)
              : 'Branch issue, PR, and saved branch links will appear here.'}
          </Typography.Text>
          {loadError && (
            <Alert type="warning" showIcon message="Failed to load links" description={loadError} />
          )}
          <LinkDisplayList
            items={displayItems}
            emptyDescription="No branch links yet"
            showPinActions
            pinActionDisabled={!client}
            pinningLinkId={pinningLinkId}
            onTogglePinned={handleTogglePinned}
            getAssistantActionState={assistantStateForItem}
            onPromoteToAssistant={handlePromoteToAssistant}
            onRemoveFromAssistant={handleRemoveFromAssistant}
          />
        </Space>
      </Card>
    </div>
  );
};

export default LinksTab;
