/**
 * The Catalog: browse the MCP catalog, open an entry, connect it.
 *
 * Filtering and paging happen in SQL — the grid renders one page and never the
 * result set, because the catalog reaches thousands of rows once registry
 * ingestion is on.
 */

import type { AgenticToolName, MCPCatalogCategory, MCPCatalogEntry } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { sessionPath } from '@agor-live/client';
import { Alert, Col, Empty, Flex, Pagination, Row, Skeleton, Typography, theme } from 'antd';
import { memo, useCallback, useMemo, useState } from 'react';
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

const { Text } = Typography;

const GRID_SPANS = { xs: 24, sm: 12, lg: 8, xxl: 6 } as const;

const INITIAL_FILTERS: CatalogFilterState = {
  search: '',
  reviewedOnly: false,
  sort: DEFAULT_SORT,
};

/**
 * The grid is memoized separately from the toolbar so a filter change that
 * leaves the page identical (e.g. re-selecting the same sort) doesn't rebuild
 * every card.
 */
const CatalogGrid = memo<{
  entries: MCPCatalogEntry[];
  onOpen: (entry: MCPCatalogEntry) => void;
}>(({ entries, onOpen }) => (
  <Row gutter={[16, 16]}>
    {entries.map((entry) => (
      <Col key={entry.catalog_entry_id} {...GRID_SPANS}>
        <CatalogCard entry={entry} onOpen={onOpen} />
      </Col>
    ))}
  </Row>
));

export interface CatalogTabProps {
  client: AgorClient;
}

export const CatalogTab: React.FC<CatalogTabProps> = ({ client }) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();

  const [filters, setFilters] = useState<CatalogFilterState>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MCPCatalogEntry | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const { entries, matchCount, catalogSize, loading, error } = useCatalogSearch(
    client,
    filters,
    page
  );
  const {
    branches,
    loading: branchesLoading,
    error: branchesError,
  } = useConnectTargets(client, selected !== null);

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
  const onReviewedOnlyChange = useCallback(
    (reviewedOnly: boolean) => applyFilter({ reviewedOnly }),
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
      isFilterActive(filters) && catalogSize !== null
        ? { matched: matchCount, total: catalogSize }
        : null,
    [filters, catalogSize, matchCount]
  );

  const handleConnect = useCallback(
    async ({ branchId, agenticTool }: { branchId: string; agenticTool: AgenticToolName }) => {
      if (!selected) return;
      setConnecting(true);
      setConnectError(null);
      try {
        const result = await client.service('mcp-catalog/connect').create({
          catalog_key: selected.catalog_entry_id,
          branch_id: branchId,
          agentic_tool: agenticTool,
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
        reviewedOnly={filters.reviewedOnly}
        sort={filters.sort}
        onSearchChange={onSearchChange}
        onCategoryChange={onCategoryChange}
        onCapabilityChange={onCapabilityChange}
        onReviewedOnlyChange={onReviewedOnlyChange}
        onSortChange={onSortChange}
        matchSummary={matchSummary}
      />

      {error ? (
        <Alert type="error" showIcon message="Could not load the catalog" description={error} />
      ) : loading && entries.length === 0 ? (
        <Row gutter={[16, 16]}>
          {Array.from({ length: 6 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder grid
            <Col key={index} {...GRID_SPANS}>
              <Skeleton active paragraph={{ rows: 2 }} />
            </Col>
          ))}
        </Row>
      ) : entries.length === 0 ? (
        <Empty description="No servers match" />
      ) : (
        <CatalogGrid entries={entries} onOpen={openEntry} />
      )}

      {matchCount > CATALOG_PAGE_SIZE && (
        <Flex justify="flex-end" align="center" gap={token.margin}>
          {loading && <Text type="secondary">Loading…</Text>}
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
