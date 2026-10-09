import type { AgorClient, Board, BoardEntityObject, Branch, Repo } from '@agor-live/client';
import { EnvironmentOutlined } from '@ant-design/icons';
import { Skeleton, Tag, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecenterMap } from '../../contexts/CanvasNavigationContext';
import { formatRelativeTime, formatTimestampWithRelative } from '../../utils/time';
import { BranchBoardLocatorIcon } from '../BranchBoardLocatorIcon';
import { BranchStateTag } from '../BranchFilesystemRecovery';
import { CompactNotice } from '../CompactNotice';
import { RepoPill } from '../Pill';

/**
 * Branch enriched with zone-pinning info. The `branches` service `find()`
 * attaches `zone_id`/`zone_label` server-side (see
 * `BranchRepository.enrichManyWithZoneInfo`). `BranchWithZone` lives in the
 * repository layer and isn't exported to the client bundle, so we annotate the
 * canonical `Branch` with the two enrichment fields locally.
 */
type BoardBranch = Branch & { zone_id?: string; zone_label?: string };

export interface BoardBranchListProps {
  board?: Board;
  repoById: Map<string, Repo>;
  client: AgorClient | null;
  onAfterBranchClick?: () => void;
}

/**
 * "All branches" tab body. Mirrors {@link BoardSessionList} but lists the
 * branches associated with the current board — including archived (hidden)
 * ones, which the global store intentionally omits. Each row pans the board
 * camera onto the branch card, reusing the same recenter channel as the
 * session locator button.
 */
export const BoardBranchList: React.FC<BoardBranchListProps> = ({
  board,
  repoById,
  client,
  onAfterBranchClick,
}) => {
  const { token } = theme.useToken();
  const recenterMap = useRecenterMap();
  const [branches, setBranches] = useState<BoardBranch[]>([]);
  const [loading, setLoading] = useState(false);
  // Set by the first successful read; until then the list shows a skeleton or the load error.
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Keep client stable for the event-listener effect without re-subscribing.
  const clientRef = useRef(client);
  clientRef.current = client;

  const boardId = board?.board_id;
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;

  const loadBranches = useCallback(async () => {
    const currentClient = clientRef.current;
    if (!currentClient || !boardId) return;

    setLoading(true);
    try {
      // Omit the `archived` filter so BOTH shown and hidden branches come
      // back. The response is enriched with zone_id/zone_label by the daemon.
      const result = await currentClient.service('branches').findAll({
        query: {
          board_id: boardId,
          $limit: 1000,
        },
      });
      if (boardIdRef.current !== boardId) return;
      setBranches(result as BoardBranch[]);
      setLoaded(true);
      setLoadError(null);
    } catch (error) {
      if (boardIdRef.current !== boardId) return;
      // The last-known list stays in place under the refresh warning.
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new board starts from an empty, unloaded list
  useEffect(() => {
    setBranches([]);
    setLoaded(false);
    setLoadError(null);
  }, [boardId]);

  // Also loads once the client connects; until then the skeleton stays up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `client` re-runs the read when it first arrives
  useEffect(() => {
    void loadBranches();
  }, [client, loadBranches]);

  // Refresh on structural changes to branches on this board. Branch counts are
  // small, so a full board-scoped refetch keeps zone/archived state accurate
  // without hand-merging partial patch payloads.
  useEffect(() => {
    if (!client || !boardId) return;
    const branchesService = client.service('branches');

    const refreshIfBranchRelevant = (branch: Branch) => {
      if (branch.board_id === boardId) void loadBranches();
    };

    branchesService.on('created', refreshIfBranchRelevant);
    branchesService.on('patched', refreshIfBranchRelevant);
    branchesService.on('updated', refreshIfBranchRelevant);
    branchesService.on('removed', refreshIfBranchRelevant);

    // Zone pinning lives on `board_objects.data.zone_id`, not on the branch
    // row (see BranchRepository.enrichManyWithZoneInfo). Moving a card between
    // zones patches the `board-objects` service, so a branch event never fires
    // — without this listener the zone pill only updates on a page refresh.
    const boardObjectsService = client.service('board-objects');

    const refreshIfBoardObjectRelevant = (boardObject: BoardEntityObject) => {
      if (boardObject.board_id === boardId) void loadBranches();
    };

    boardObjectsService.on('created', refreshIfBoardObjectRelevant);
    boardObjectsService.on('patched', refreshIfBoardObjectRelevant);
    boardObjectsService.on('updated', refreshIfBoardObjectRelevant);
    boardObjectsService.on('removed', refreshIfBoardObjectRelevant);

    return () => {
      branchesService.removeListener('created', refreshIfBranchRelevant);
      branchesService.removeListener('patched', refreshIfBranchRelevant);
      branchesService.removeListener('updated', refreshIfBranchRelevant);
      branchesService.removeListener('removed', refreshIfBranchRelevant);

      boardObjectsService.removeListener('created', refreshIfBoardObjectRelevant);
      boardObjectsService.removeListener('patched', refreshIfBoardObjectRelevant);
      boardObjectsService.removeListener('updated', refreshIfBoardObjectRelevant);
      boardObjectsService.removeListener('removed', refreshIfBoardObjectRelevant);
    };
  }, [client, boardId, loadBranches]);

  // Active branches first, then archived; each group most-recently-used first.
  const sortedBranches = useMemo(() => {
    return [...branches].sort((a, b) => {
      if (Boolean(a.archived) !== Boolean(b.archived)) {
        return a.archived ? 1 : -1;
      }
      return (b.last_used ?? '').localeCompare(a.last_used ?? '');
    });
  }, [branches]);

  if (!board) {
    return null;
  }

  // The count is hidden until the first read lands, so a failed load never reads "0 branches".
  const footerText = [
    loaded && `${sortedBranches.length} ${sortedBranches.length === 1 ? 'branch' : 'branches'}`,
    board.description,
  ]
    .filter(Boolean)
    .join(' • ');

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <section
        aria-label="Board branches"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus the scrollable list to reach older branches.
        tabIndex={0}
        style={{ padding: '8px 0', flex: 1, minHeight: 0, overflowY: 'auto' }}
      >
        {loadError && (
          <CompactNotice
            type={loaded ? 'warning' : 'error'}
            role={loaded ? 'status' : 'alert'}
            message={
              loaded
                ? "Couldn't refresh branches. This list may be out of date."
                : "Couldn't load branches."
            }
            actions={[{ label: 'Try again', onClick: () => void loadBranches(), loading }]}
            details={[{ label: 'Error', value: loadError, code: true }]}
            style={{ marginInline: 24, marginBlockEnd: 8 }}
          />
        )}
        {!loaded ? (
          !loadError && (
            <div style={{ padding: 16 }}>
              <Skeleton active paragraph={{ rows: 4 }} title={false} />
            </div>
          )
        ) : sortedBranches.length === 0 ? (
          <Typography.Text
            type="secondary"
            style={{ display: 'block', textAlign: 'center', padding: '24px 0', fontSize: 12 }}
          >
            No branches on this board yet.
          </Typography.Text>
        ) : (
          sortedBranches.map((branch) => {
            const repo = repoById.get(branch.repo_id);
            const branchTitle = repo ? `${repo.slug} / ${branch.name}` : branch.name;

            return (
              <div
                key={branch.branch_id}
                style={{
                  cursor: 'pointer',
                  padding: '10px 24px',
                  transition: 'background 0.2s',
                  opacity: branch.archived ? 0.6 : 1,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = token.colorBgTextHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
                onClick={() => {
                  if (boardId) recenterMap(branch.branch_id, { boardId });
                  onAfterBranchClick?.();
                }}
              >
                {/* Line 1: branch name · archived and status tags · pan-to button */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0,
                  }}
                >
                  <Typography.Text
                    ellipsis={{ tooltip: branchTitle }}
                    style={{ flex: 1, minWidth: 0, fontWeight: 500 }}
                  >
                    {branch.name}
                  </Typography.Text>
                  {branch.archived && (
                    <Tag color="default" style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                      Archived
                    </Tag>
                  )}
                  <BranchStateTag branch={branch} style={{ marginInlineEnd: 0, flexShrink: 0 }} />
                  <BranchBoardLocatorIcon branch={branch} size={14} />
                </div>

                {/* Line 2: repo pill · zone label · relative timestamp */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginTop: 6,
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      minWidth: 0,
                      overflow: 'hidden',
                    }}
                  >
                    {repo && <RepoPill repoName={repo.slug} color="default" />}
                    {branch.zone_label ? (
                      <Tag
                        icon={<EnvironmentOutlined />}
                        color="geekblue"
                        style={{ marginInlineEnd: 0, maxWidth: '100%' }}
                        title={`Pinned to zone: ${branch.zone_label}`}
                      >
                        {branch.zone_label}
                      </Tag>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        No zone
                      </Typography.Text>
                    )}
                  </div>
                  <Tooltip title={formatTimestampWithRelative(branch.last_used)}>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      {formatRelativeTime(branch.last_used)}
                    </Typography.Text>
                  </Tooltip>
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* Board Info Footer */}
      {footerText && (
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${token.colorBorder}`,
            background: token.colorBgContainer,
            flexShrink: 0,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {footerText}
          </Typography.Text>
        </div>
      )}
    </div>
  );
};

export default BoardBranchList;
