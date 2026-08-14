/**
 * The Catalog: browse the MCP catalog, open an entry, connect it.
 *
 * The grid renders one page at a time. Filtering, ordering and paging are the
 * server's, so the toolbar's controls stay one query rather than growing a
 * second, divergent implementation here.
 */

import type { AgenticToolName, MCPCatalogCategory, MCPCatalogEntry } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { sessionPath } from '@agor-live/client';
import { Alert, Button, Col, Empty, Flex, Pagination, Row, Skeleton, theme } from 'antd';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { savePromptDraft } from '../../utils/promptDrafts';
import { CatalogCard } from './CatalogCard';
import { CatalogDetailDrawer } from './CatalogDetailDrawer';
import { CatalogToolbar } from './CatalogToolbar';
import { DEFAULT_SORT } from './catalogPresentation';
import {
  CATALOG_PAGE_SIZE,
  type CatalogFilterState,
  isFilterActive,
  useCatalogSearch,
} from './useCatalogSearch';
import {
  getLastConnectBranchId,
  rememberConnectBranchId,
  useConnectTargets,
} from './useConnectTargets';

const GRID_SPANS = { xs: 24, sm: 12, lg: 8, xxl: 6 } as const;

const INITIAL_FILTERS: CatalogFilterState = {
  search: '',
  connectableOnly: false,
  sort: DEFAULT_SORT,
};

/**
 * The grid is memoized separately from the toolbar so a filter change that
 * leaves the page identical (e.g. re-selecting the same sort) doesn't rebuild
 * every card.
 */
/**
 * True once `active` has held for `delayMs`.
 *
 * A normal load is connected inside a second, so announcing every one of those
 * would be noise. A disconnection that outlasts the delay is the case worth
 * naming — otherwise the skeleton spins forever and says nothing.
 */
function useSettledFlag(active: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!active) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return settled;
}

const DISCONNECT_NOTICE_DELAY_MS = 2000;

const CatalogGrid = memo<{
  entries: MCPCatalogEntry[];
  onOpen: (entry: MCPCatalogEntry) => void;
}>(({ entries, onOpen }) => (
  <Row gutter={[16, 16]}>
    {entries.map((entry) => (
      <Col key={entry.name} {...GRID_SPANS}>
        <CatalogCard entry={entry} onOpen={onOpen} />
      </Col>
    ))}
  </Row>
));

export interface CatalogTabProps {
  client: AgorClient | null;
  /** The socket has connected and authenticated, so reads will be answered. */
  connected: boolean;
}

export const CatalogTab: React.FC<CatalogTabProps> = ({ client, connected }) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();

  const [filters, setFilters] = useState<CatalogFilterState>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MCPCatalogEntry | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const showDisconnected = useSettledFlag(!connected, DISCONNECT_NOTICE_DELAY_MS);

  const { entries, status, matchCount, catalogSize, error, retry } = useCatalogSearch(
    client,
    connected,
    filters,
    page
  );
  const {
    branches,
    loading: branchesLoading,
    error: branchesError,
  } = useConnectTargets(client, connected && selected !== null);

  // Any narrowing invalidates the current offset — page 4 of an unfiltered
  // catalog is usually past the end of a filtered one.
  const applyFilter = useCallback((patch: Partial<CatalogFilterState>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }, []);

  const onSearchChange = useCallback((search: string) => applyFilter({ search }), [applyFilter]);
  const onCategoryChange = useCallback(
    (category?: MCPCatalogCategory) => applyFilter({ category }),
    [applyFilter]
  );
  const onCapabilityChange = useCallback(
    (capability?: string) => applyFilter({ capability }),
    [applyFilter]
  );
  const onConnectableOnlyChange = useCallback(
    (connectableOnly: boolean) => applyFilter({ connectableOnly }),
    [applyFilter]
  );
  const onSortChange = useCallback(
    (sort: CatalogFilterState['sort']) => applyFilter({ sort }),
    [applyFilter]
  );

  const openEntry = useCallback((entry: MCPCatalogEntry) => {
    setConnectError(null);
    setSelected(entry);
  }, []);

  const closeDrawer = useCallback(() => {
    setSelected(null);
    setConnectError(null);
  }, []);

  // `REQ-CAT-3`: the count is a filtering aid, so it appears only once
  // filtering is happening.
  const matchSummary = useMemo(
    () =>
      status === 'ready' && isFilterActive(filters) && catalogSize !== null
        ? { matched: matchCount, total: catalogSize }
        : null,
    [status, filters, catalogSize, matchCount]
  );

  const handleConnect = useCallback(
    async ({
      branchId,
      agenticTool,
      acknowledgedDisclosure,
    }: {
      branchId: string;
      agenticTool: AgenticToolName;
      acknowledgedDisclosure: string;
    }) => {
      if (!selected || !client) return;
      setConnecting(true);
      setConnectError(null);
      try {
        const result = await client.service('mcp-catalog/connect').create({
          catalog_key: selected.name,
          branch_id: branchId,
          agentic_tool: agenticTool,
          acknowledged_disclosure: acknowledgedDisclosure,
        });
        rememberConnectBranchId(branchId);
        if (result.starter_prompt) {
          savePromptDraft(result.session.session_id, result.starter_prompt);
        }
        setSelected(null);
        navigate(sessionPath(result.session.session_id));
      } catch (err: unknown) {
        setConnectError(err instanceof Error ? err.message : 'Could not connect this server');
      } finally {
        setConnecting(false);
      }
    },
    [client, navigate, selected]
  );

  return (
    <Flex vertical gap={token.margin}>
      <CatalogToolbar
        search={filters.search}
        category={filters.category}
        capability={filters.capability}
        connectableOnly={filters.connectableOnly}
        sort={filters.sort}
        onSearchChange={onSearchChange}
        onCategoryChange={onCategoryChange}
        onCapabilityChange={onCapabilityChange}
        onConnectableOnlyChange={onConnectableOnlyChange}
        onSortChange={onSortChange}
        matchSummary={matchSummary}
      />

      {showDisconnected && (
        <Alert
          type="warning"
          showIcon
          message="Not connected to the Agor daemon"
          description="The catalog will load as soon as the connection is back."
        />
      )}

      {/* `empty` is only reachable from a read that returned. A failed read
          renders as a failure, never as a catalog with nothing in it. */}
      {status === 'error' ? (
        <Alert
          type="error"
          showIcon
          message="Could not load the catalog"
          description={error}
          action={
            <Button size="small" onClick={retry}>
              Retry
            </Button>
          }
        />
      ) : status === 'loading' ? (
        showDisconnected ? null : (
          <Row gutter={[16, 16]}>
            {Array.from({ length: 6 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder grid
              <Col key={index} {...GRID_SPANS}>
                <Skeleton active paragraph={{ rows: 2 }} />
              </Col>
            ))}
          </Row>
        )
      ) : entries.length === 0 ? (
        // "No servers match" means the filters excluded everything. With
        // nothing filtering there is nothing to have excluded, so an empty read
        // means the daemon could not read its catalog at all.
        isFilterActive(filters) ? (
          <Empty description="No servers match" />
        ) : (
          <Empty description="No servers in the catalog yet">
            <Button onClick={retry}>Check again</Button>
          </Empty>
        )
      ) : (
        <CatalogGrid entries={entries} onOpen={openEntry} />
      )}

      {status === 'ready' && matchCount > CATALOG_PAGE_SIZE && (
        <Flex justify="flex-end" align="center" gap={token.margin}>
          <Pagination
            current={page}
            pageSize={CATALOG_PAGE_SIZE}
            total={matchCount}
            showSizeChanger={false}
            onChange={setPage}
          />
        </Flex>
      )}

      <CatalogDetailDrawer
        entry={selected}
        open={selected !== null}
        onClose={closeDrawer}
        branches={branches}
        branchesLoading={branchesLoading}
        branchesError={branchesError}
        defaultBranchId={getLastConnectBranchId()}
        connecting={connecting}
        connectError={connectError}
        onConnect={handleConnect}
      />
    </Flex>
  );
};
