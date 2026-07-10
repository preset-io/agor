import type { AgorClient, Branch, Link, Session } from '@agor-live/client';
import { Alert, Empty, Flex, List, Space, Spin, theme } from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgorStore } from '../../../store/agorStore';
import {
  makeLinksForBranchSelector,
  selectApplyKnownLinkCreatedResult,
  selectApplyKnownLinkRemovedResult,
  selectApplyLinkMutationResult,
  selectBoardById,
  selectFetchAndReplaceFullBranchLinks,
  selectSessionById,
} from '../../../store/selectors';
import { useThemedMessage } from '../../../utils/message';
import {
  buildLinkDisplayItems,
  compareLinkDisplayItemsBySort,
  getLinkCategoryCounts,
  type LinkCategoryTabKey,
  type LinkDisplayItem,
  type LinkSortKey,
  matchesLinkCategoryTab,
  matchesLinkDisplaySearch,
  promoteLinkToTeammate,
} from '../../Links';
import { LinkCollectionControls } from '../../Links/LinkCollectionControls';
import styles from '../../Links/linkUi.module.css';
import { LinkPreviewModal, useLinkFileActions } from '../../Links/SessionLinksControl';
import { BranchLinkListItem } from './BranchLinkListItem';

interface LinksTabProps {
  branch: Branch;
  client: AgorClient | null;
  active: boolean;
  open: boolean;
}

function getSessionLabel(session: Session | undefined, sessionId: string): string {
  const title = typeof session?.title === 'string' ? session.title.trim() : '';
  return title || sessionId.slice(0, 8);
}

function getSourceSessionLabel(
  item: LinkDisplayItem,
  sessionById: Map<string, Session>
): string | null {
  const sessionId = item.sourceSessionId ?? item.sessionId;
  if (!sessionId) return null;
  return getSessionLabel(sessionById.get(sessionId), sessionId);
}

function itemMatchesSearch(
  item: LinkDisplayItem,
  query: string,
  sessionById: Map<string, Session>
): boolean {
  return matchesLinkDisplaySearch(item, query, [getSourceSessionLabel(item, sessionById)]);
}

const LinksTabInner: React.FC<LinksTabProps> = ({ branch, client, active, open }) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { showSuccess, showError } = useThemedMessage();
  const boardById = useAgorStore(selectBoardById);
  const sessionById = useAgorStore(selectSessionById);
  const fetchAndReplaceFullBranchLinks = useAgorStore(selectFetchAndReplaceFullBranchLinks);
  const applyLinkMutationResult = useAgorStore(selectApplyLinkMutationResult);
  const applyKnownLinkCreatedResult = useAgorStore(selectApplyKnownLinkCreatedResult);
  const applyKnownLinkRemovedResult = useAgorStore(selectApplyKnownLinkRemovedResult);
  const branchLinksSelector = useMemo(
    () => makeLinksForBranchSelector(branch.branch_id),
    [branch.branch_id]
  );
  const links = useAgorStore(branchLinksSelector) ?? [];
  const teammateBranchId = branch.board_id
    ? (boardById.get(branch.board_id)?.primary_teammate_id ?? null)
    : null;
  const teammateLinksSelector = useMemo(
    () => makeLinksForBranchSelector(teammateBranchId ?? ''),
    [teammateBranchId]
  );
  const teammateLinks = useAgorStore(teammateLinksSelector) ?? [];
  const teammatePromotionLinks = teammateBranchId === branch.branch_id ? links : teammateLinks;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinningLinkId, setPinningLinkId] = useState<string | null>(null);
  const [teammatePromotionBusyKey, setTeammatePromotionBusyKey] = useState<string | null>(null);
  const { preview, setPreview, openItem } = useLinkFileActions(navigate);
  const [activeCategory, setActiveCategory] = useState<LinkCategoryTabKey>('all');
  const [sortOrder, setSortOrder] = useState<LinkSortKey>('az');
  const [searchQuery, setSearchQuery] = useState('');

  const hydrate = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const requests = [fetchAndReplaceFullBranchLinks(client, branch.branch_id)];
      if (teammateBranchId && teammateBranchId !== branch.branch_id) {
        requests.push(fetchAndReplaceFullBranchLinks(client, teammateBranchId));
      }
      await Promise.all(requests);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Could not load branch links');
    } finally {
      setLoading(false);
    }
  }, [teammateBranchId, branch.branch_id, client, fetchAndReplaceFullBranchLinks]);

  useEffect(() => {
    if (!open || !active || !client) return;
    void hydrate();
  }, [active, client, hydrate, open]);

  const items = useMemo(() => buildLinkDisplayItems({ branch, links }), [branch, links]);
  const categoryCounts = useMemo(() => getLinkCategoryCounts(items), [items]);
  const visibleItems = useMemo(
    () =>
      items
        .filter((item) => matchesLinkCategoryTab(item, activeCategory))
        .filter((item) => itemMatchesSearch(item, searchQuery, sessionById))
        .sort((a, b) => compareLinkDisplayItemsBySort(a, b, sortOrder)),
    [activeCategory, items, searchQuery, sessionById, sortOrder]
  );

  const handleTogglePinned = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || !item.linkId || pinningLinkId) return;
      setPinningLinkId(item.linkId);
      try {
        const updated = (await client.service('links').patch(item.linkId, {
          is_pinned: !item.isPinned,
        })) as Link;
        applyLinkMutationResult(updated);
      } catch (err) {
        showError(`Failed to update pin: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPinningLinkId(null);
      }
    },
    [applyLinkMutationResult, client, pinningLinkId, showError]
  );

  const handlePromoteToTeammate = useCallback(
    async (item: LinkDisplayItem) => {
      if (!client || !teammateBranchId || !item.linkId || teammatePromotionBusyKey) return;
      setTeammatePromotionBusyKey(item.linkId);
      try {
        const promoted = await promoteLinkToTeammate({
          client,
          sourceLinkId: item.linkId,
          teammateBranchId,
        });
        applyKnownLinkCreatedResult(promoted);
        showSuccess('Promoted to teammate');
      } catch (err) {
        showError(`Failed to promote link: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setTeammatePromotionBusyKey(null);
      }
    },
    [
      applyKnownLinkCreatedResult,
      teammateBranchId,
      teammatePromotionBusyKey,
      client,
      showError,
      showSuccess,
    ]
  );

  const handleRemoveFromTeammate = useCallback(
    async (_item: LinkDisplayItem, teammateLinkId: string) => {
      if (!client || teammatePromotionBusyKey) return;
      setTeammatePromotionBusyKey(teammateLinkId);
      try {
        const removed = (await client.service('links').remove(teammateLinkId)) as Link;
        applyKnownLinkRemovedResult(removed);
        showSuccess('Removed from teammate');
      } catch (err) {
        showError(
          `Failed to remove teammate link: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setTeammatePromotionBusyKey(null);
      }
    },
    [applyKnownLinkRemovedResult, teammatePromotionBusyKey, client, showError, showSuccess]
  );

  return (
    <>
      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
      <div className={styles.linkListViewport} data-testid="branch-links-tab">
        <Space className={styles.fullWidth} direction="vertical" size={token.sizeMD}>
          {error && (
            <div style={{ padding: `0 ${token.paddingLG}px` }}>
              <Alert message="Error" description={error} type="error" showIcon />
            </div>
          )}

          {loading ? (
            <Flex className={styles.linkListLoading} align="center" justify="center">
              <Spin />
            </Flex>
          ) : items.length > 0 ? (
            <Space className={styles.fullWidth} direction="vertical" size={token.sizeMD}>
              <div style={{ padding: `0 ${token.paddingLG}px` }}>
                <LinkCollectionControls
                  categoryCounts={categoryCounts}
                  activeCategory={activeCategory}
                  onCategoryChange={setActiveCategory}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  sortOrder={sortOrder}
                  onSortChange={setSortOrder}
                />
              </div>
              {visibleItems.length > 0 ? (
                <List
                  style={{ padding: `0 ${token.paddingLG}px` }}
                  dataSource={visibleItems}
                  renderItem={(item) => (
                    <BranchLinkListItem
                      key={item.key}
                      item={item}
                      sourceSessionLabel={getSourceSessionLabel(item, sessionById)}
                      teammateBranchId={teammateBranchId}
                      teammateLinks={teammatePromotionLinks}
                      sourceBranchId={branch.branch_id}
                      teammateBusyKey={teammatePromotionBusyKey}
                      pinning={item.linkId === pinningLinkId}
                      onOpen={openItem}
                      onTogglePinned={handleTogglePinned}
                      onPromote={handlePromoteToTeammate}
                      onRemove={handleRemoveFromTeammate}
                    />
                  )}
                />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No links match this view."
                />
              )}
            </Space>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No durable branch links yet. Add branch-owned links here when they should persist with the branch."
            />
          )}
        </Space>
      </div>
    </>
  );
};

export const LinksTab = memo(LinksTabInner, (prevProps, nextProps) => {
  return (
    prevProps.client === nextProps.client &&
    prevProps.active === nextProps.active &&
    prevProps.open === nextProps.open &&
    prevProps.branch.branch_id === nextProps.branch.branch_id &&
    prevProps.branch.board_id === nextProps.branch.board_id &&
    prevProps.branch.issue_url === nextProps.branch.issue_url &&
    prevProps.branch.pull_request_url === nextProps.branch.pull_request_url
  );
});
