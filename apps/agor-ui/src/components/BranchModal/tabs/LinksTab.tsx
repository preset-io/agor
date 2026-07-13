import { type AgorClient, type Branch, type Session, shortId } from '@agor-live/client';
import { Alert, Empty, Flex, List, Space, Spin, theme } from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgorStore } from '../../../store/agorStore';
import {
  makeLinksForBranchSelector,
  selectBoardById,
  selectFetchAndReplaceFullBranchLinks,
  selectSessionById,
} from '../../../store/selectors';
import {
  buildLinkDisplayItems,
  compareLinkDisplayItemsBySort,
  getLinkCategoryCounts,
  type LinkCategoryTabKey,
  type LinkDisplayItem,
  type LinkSortKey,
  matchesLinkCategoryTab,
  matchesLinkDisplaySearch,
  useLinkMutations,
} from '../../Links';
import { LinkCollectionControls } from '../../Links/LinkCollectionControls';
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
  return title || shortId(sessionId);
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
  const boardById = useAgorStore(selectBoardById);
  const sessionById = useAgorStore(selectSessionById);
  const fetchAndReplaceFullBranchLinks = useAgorStore(selectFetchAndReplaceFullBranchLinks);
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
  const {
    pinningKeys,
    teammateBusyKeys,
    togglePinned: handleTogglePinned,
    promoteToTeammate: handlePromoteToTeammate,
    removeFromTeammate: handleRemoveFromTeammate,
  } = useLinkMutations({
    client,
    branchId: branch.branch_id,
    teammateBranchId,
  });
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

  return (
    <>
      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
      <div
        data-testid="branch-links-tab"
        style={{ width: '100%', height: '70vh', overflowY: 'auto' }}
      >
        <Space direction="vertical" size={token.sizeMD} style={{ width: '100%' }}>
          {error && (
            <div style={{ paddingInline: token.paddingLG }}>
              <Alert message="Error" description={error} type="error" showIcon />
            </div>
          )}

          {loading ? (
            <Flex align="center" justify="center" style={{ minHeight: 180 }}>
              <Spin />
            </Flex>
          ) : items.length > 0 ? (
            <Space direction="vertical" size={token.sizeMD} style={{ width: '100%' }}>
              <div style={{ paddingInline: token.paddingLG }}>
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
                  style={{ paddingInline: token.paddingLG }}
                  dataSource={visibleItems}
                  renderItem={(item) => (
                    <BranchLinkListItem
                      key={item.key}
                      item={item}
                      sourceSessionLabel={getSourceSessionLabel(item, sessionById)}
                      teammateBranchId={teammateBranchId}
                      teammateLinks={teammatePromotionLinks}
                      sourceBranchId={branch.branch_id}
                      teammateBusyKeys={teammateBusyKeys}
                      pinning={pinningKeys.has(item.linkId ?? item.key)}
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
