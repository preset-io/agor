import { type AgorClient, type Branch, isTeammate, type Session, shortId } from '@agor-live/client';
import { PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Flex, List, Space, Spin, theme } from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgorStore } from '../../../store/agorStore';
import {
  makeLinksForBranchSelector,
  selectBoardById,
  selectBranchById,
  selectFetchAndReplaceFullBranchLinks,
  selectSessionById,
} from '../../../store/selectors';
import {
  buildLinkDisplayItems,
  canEditLinkTarget,
  compareLinkDisplayItemsBySort,
  getLinkCategoryCounts,
  getLinkPlacementAction,
  getLinkPromotionActions,
  LINK_ACTION_KEY,
  LINK_ACTION_LABEL,
  LINK_OWNER_SCOPE,
  LINK_PROMOTION_DESTINATION,
  type LinkCategoryTabKey,
  type LinkDisplayItem,
  LinkEditorModal,
  type LinkMenuAction,
  LinkPlacementDestinationModal,
  type LinkPlacementDestinationOption,
  type LinkPlacementDestinationScope,
  type LinkSortKey,
  type ManualLinkDraft,
  matchesLinkCategoryTab,
  matchesLinkDisplaySearch,
  useLinkMutations,
} from '../../Links';
import { LinkCollectionControls } from '../../Links/LinkCollectionControls';
import linkStyles from '../../Links/linkUi.module.css';
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

const TEAMMATE_DESTINATION_ACTIONS = [
  {
    key: LINK_ACTION_KEY.promoteToBranchPicker,
    label: LINK_ACTION_LABEL.promoteToBranchPicker,
  },
  {
    key: LINK_ACTION_KEY.promoteToSessionPicker,
    label: LINK_ACTION_LABEL.promoteToSessionPicker,
  },
] as const satisfies readonly LinkMenuAction[];

const LinksTabInner: React.FC<LinksTabProps> = ({ branch, client, active, open }) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const boardById = useAgorStore(selectBoardById);
  const branchById = useAgorStore(selectBranchById);
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

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    pinningKeys,
    lifecycleBusyKeys,
    placementLoadingKeys,
    togglePinned: handleTogglePinned,
    createLink,
    updateLink,
    removeLink,
    placementsByTargetKey,
    refreshPlacements: handleRefreshPlacements,
    applyPlacementAction: handlePlacementAction,
  } = useLinkMutations({
    client,
    branchId: branch.branch_id,
  });
  const { preview, setPreview, openItem } = useLinkFileActions(navigate);
  const [activeCategory, setActiveCategory] = useState<LinkCategoryTabKey>('all');
  const [sortOrder, setSortOrder] = useState<LinkSortKey>('az');
  const [searchQuery, setSearchQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorItem, setEditorItem] = useState<LinkDisplayItem | null>(null);
  const [placementDestination, setPlacementDestination] = useState<{
    item: LinkDisplayItem;
    scope: LinkPlacementDestinationScope;
  } | null>(null);

  const hydrate = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      await fetchAndReplaceFullBranchLinks(client, branch.branch_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Could not load branch links');
    } finally {
      setLoading(false);
    }
  }, [branch.branch_id, client, fetchAndReplaceFullBranchLinks]);

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

  const openAddLink = () => {
    setEditorItem(null);
    setEditorOpen(true);
  };

  const openEditLink = (item: LinkDisplayItem) => {
    setEditorItem(item);
    setEditorOpen(true);
  };

  const submitEditor = (draft: ManualLinkDraft) => {
    if (!editorItem) return createLink(draft, LINK_OWNER_SCOPE.branch);
    return updateLink(editorItem, {
      title: draft.title,
      ...(canEditLinkTarget(editorItem) ? { target: draft.target } : {}),
    });
  };

  const openPlacementDestination = (item: LinkDisplayItem, action: LinkMenuAction) => {
    const scope: LinkPlacementDestinationScope =
      action.key === LINK_ACTION_KEY.promoteToSessionPicker
        ? LINK_OWNER_SCOPE.session
        : LINK_OWNER_SCOPE.branch;
    setPlacementDestination({ item, scope });
    void handleRefreshPlacements(item);
  };

  const placementDestinationOptions = useMemo<LinkPlacementDestinationOption[]>(() => {
    if (!placementDestination || !branch.board_id) return [];
    const placements = placementsByTargetKey.get(placementDestination.item.targetKey) ?? [];
    if (placementDestination.scope === LINK_OWNER_SCOPE.branch) {
      return Array.from(branchById.values())
        .filter(
          (candidate) =>
            candidate.board_id === branch.board_id &&
            !candidate.archived &&
            !isTeammate(candidate) &&
            candidate.branch_id !== branch.branch_id
        )
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((candidate) => ({
          key: candidate.branch_id,
          label: candidate.name,
          action: getLinkPlacementAction(
            {
              destination: LINK_PROMOTION_DESTINATION.branch,
              branchId: candidate.branch_id,
            },
            placements,
            Boolean(client)
          ),
        }));
    }

    return Array.from(sessionById.values())
      .filter((candidate) => {
        const ownerBranch = branchById.get(candidate.branch_id);
        return ownerBranch?.board_id === branch.board_id && !candidate.archived;
      })
      .sort((left, right) =>
        getSessionLabel(left, left.session_id).localeCompare(
          getSessionLabel(right, right.session_id)
        )
      )
      .map((candidate) => ({
        key: candidate.session_id,
        label: getSessionLabel(candidate, candidate.session_id),
        description: branchById.get(candidate.branch_id)?.name,
        action: getLinkPlacementAction(
          {
            destination: LINK_PROMOTION_DESTINATION.session,
            sessionId: candidate.session_id,
          },
          placements,
          Boolean(client)
        ),
      }));
  }, [
    branch.board_id,
    branch.branch_id,
    branchById,
    client,
    placementDestination,
    placementsByTargetKey,
    sessionById,
  ]);

  return (
    <>
      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
      <LinkEditorModal
        open={editorOpen}
        item={editorItem}
        onCancel={() => setEditorOpen(false)}
        onSubmit={submitEditor}
      />
      <LinkPlacementDestinationModal
        open={Boolean(placementDestination)}
        scope={placementDestination?.scope ?? LINK_OWNER_SCOPE.branch}
        options={placementDestinationOptions}
        busy={Boolean(
          placementDestination &&
            (lifecycleBusyKeys.has(
              placementDestination.item.linkId ?? placementDestination.item.key
            ) ||
              placementLoadingKeys.has(
                placementDestination.item.linkId ?? placementDestination.item.key
              ))
        )}
        onClose={() => setPlacementDestination(null)}
        onAction={(action) =>
          placementDestination
            ? handlePlacementAction(placementDestination.item, action)
            : Promise.resolve(false)
        }
      />
      <div data-testid="branch-links-tab" className={linkStyles.branchLinksTab}>
        <Space direction="vertical" size={token.sizeMD} className={linkStyles.branchLinksStack}>
          {error && (
            <div className={linkStyles.branchLinksSection}>
              <Alert message="Error" description={error} type="error" showIcon />
            </div>
          )}

          <div className={linkStyles.branchLinksSection}>
            <Flex justify="flex-end">
              <Button type="primary" icon={<PlusOutlined />} onClick={openAddLink}>
                {LINK_ACTION_LABEL.add}
              </Button>
            </Flex>
          </div>

          {loading ? (
            <Flex align="center" justify="center" className={linkStyles.branchLinksLoading}>
              <Spin />
            </Flex>
          ) : items.length > 0 ? (
            <Space direction="vertical" size={token.sizeMD} className={linkStyles.branchLinksStack}>
              <div className={linkStyles.branchLinksSection}>
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
                  className={linkStyles.branchLinksSection}
                  dataSource={visibleItems}
                  renderItem={(item) => (
                    <BranchLinkListItem
                      key={item.key}
                      item={item}
                      sourceSessionLabel={getSourceSessionLabel(item, sessionById)}
                      placementActions={getLinkPromotionActions(item, {
                        branchId: branch.branch_id,
                        teammateBranchId,
                        placements: placementsByTargetKey.get(item.targetKey),
                        available: Boolean(client),
                      })}
                      lifecycleBusy={
                        lifecycleBusyKeys.has(item.linkId ?? item.key) ||
                        placementLoadingKeys.has(item.linkId ?? item.key)
                      }
                      pinning={pinningKeys.has(item.linkId ?? item.key)}
                      onOpen={openItem}
                      onTogglePinned={handleTogglePinned}
                      onPlacementAction={handlePlacementAction}
                      onOpenPlacements={
                        isTeammate(branch) ? () => undefined : handleRefreshPlacements
                      }
                      onEdit={openEditLink}
                      onDelete={removeLink}
                      deleteLabel={
                        isTeammate(branch)
                          ? LINK_ACTION_LABEL.removeFromTeammate
                          : LINK_ACTION_LABEL.removeFromBranch
                      }
                      additionalActions={
                        isTeammate(branch) ? TEAMMATE_DESTINATION_ACTIONS : undefined
                      }
                      onAdditionalAction={(action) => openPlacementDestination(item, action)}
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
