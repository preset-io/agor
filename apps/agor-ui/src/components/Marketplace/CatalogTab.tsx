/**
 * The Catalog: browse the MCP catalog, open an entry, connect it.
 *
 * The whole catalog arrives in one read, so filtering, ordering and paging all
 * happen over what the browser holds — see `useCatalogSearch`. The grid still
 * renders one page at a time; only the round trip per page is gone.
 */

import type {
  AgenticToolName,
  MCPCatalogCategory,
  MCPCatalogCredentialRequirement,
  MCPCatalogEntry,
} from '@agor/core/types';
import { readCredentialRequirement } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { hasMinimumRole, ROLES, sessionPath } from '@agor-live/client';
import { Alert, Button, Col, Empty, Flex, Pagination, Row, Skeleton, theme } from 'antd';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useMcpMemberPolicy } from '../../hooks/useMcpMemberPolicy';
import { useAgorStore } from '../../store/agorStore';
import { selectUserAuthenticatedMcpServerIds } from '../../store/selectors';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { savePromptDraft } from '../../utils/promptDrafts';
import { type MCPServerCapabilityContext, policyPendingState } from '../MCPServer/memberPolicy';
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
  /** Disconnect grace or in-place token authentication is underway. */
  connecting: boolean;
  /** Successful socket-auth generation; stable client identity is insufficient. */
  authGeneration: number;
  /** Whose server-provided capability decides whether Connect is offered. */
  currentUser?: User | null;
}

const CatalogTabForIdentity: React.FC<CatalogTabProps> = ({
  client,
  connected,
  connecting: connectionPending,
  authGeneration,
  currentUser,
}) => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  // Same set the session panel reads, so "is this install finished?" is one
  // question with one answer wherever it is asked. On this surface it is
  // usually empty — the marketplace is standalone chrome and does not hydrate
  // the workspace store — which costs nothing: `mcpServerNeedsAuth` falls back
  // to the token the daemon injects on the read that produced `mcp_server`.
  const userAuthenticatedMcpServerIds = useAgorStore(selectUserAuthenticatedMcpServerIds);

  const [filters, setFilters] = useState<CatalogFilterState>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MCPCatalogEntry | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // What the live endpoint said it wanted, when a refusal contradicted the
  // catalog entry the drawer built its form from. Held here rather than in the
  // drawer because it arrives with the connect response, which is this
  // component's to make.
  const [keyRequirement, setKeyRequirement] = useState<MCPCatalogCredentialRequirement | null>(
    null
  );
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
  // `connected` deliberately stays true during disconnect grace, while a token
  // replacement keeps the same client object. Neither may preserve an enabled
  // action: capability reads are scoped to the authenticated generation and
  // connectionReady closes synchronously for both transitions.
  const connectionReady = connected && !connectionPending;
  const memberPolicy = useMcpMemberPolicy(client, {
    connectionReady,
    currentUser,
    authGeneration,
  });
  const { pending: policyPending, hint: policyPendingHint } = policyPendingState(memberPolicy);
  const connectCapability = useMemo<MCPServerCapabilityContext>(
    () => ({
      role: currentUser?.role,
      isAdmin: hasMinimumRole(currentUser?.role, ROLES.ADMIN),
      connectionReady,
      policy: memberPolicy.policy,
      userId: currentUser?.user_id,
      canConfigure: memberPolicy.canConfigure,
    }),
    [
      connectionReady,
      currentUser?.role,
      currentUser?.user_id,
      memberPolicy.policy,
      memberPolicy.canConfigure,
    ]
  );
  const operationGuard = useAuthorityOperationGuard(
    connectionReady && currentUser?.user_id && currentUser.role && !policyPending
      ? [
          currentUser.user_id,
          currentUser.role,
          authGeneration,
          client,
          memberPolicy.policy,
          memberPolicy.canConfigure,
        ]
      : null
  );

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
  const onSortChange = useCallback(
    (sort: CatalogFilterState['sort']) => applyFilter({ sort }),
    [applyFilter]
  );

  const openEntry = useCallback((entry: MCPCatalogEntry) => {
    setConnectError(null);
    // A requirement learned about one entry says nothing about the next.
    setKeyRequirement(null);
    setSelected(entry);
  }, []);

  const closeDrawer = useCallback(() => {
    setKeyRequirement(null);
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
      bearerToken,
    }: {
      branchId: string;
      agenticTool: AgenticToolName;
      acknowledgedDisclosure: string;
      bearerToken?: string;
    }) => {
      const operation = operationGuard.begin();
      if (!selected || !client || !operation.isCurrent()) return;
      setConnecting(true);
      setConnectError(null);
      try {
        const result = await client.service('mcp-catalog/connect').create({
          catalog_key: selected.name,
          branch_id: branchId,
          agentic_tool: agenticTool,
          acknowledged_disclosure: acknowledgedDisclosure,
          // Spread rather than sent as `undefined`: the request carries a key
          // or it carries no such field, and the daemon reads absence as "the
          // user supplied nothing" rather than having to unpick which kind of
          // empty arrived.
          ...(bearerToken ? { bearer_token: bearerToken } : {}),
        });
        if (!operation.isCurrent()) return;
        rememberConnectBranchId(currentUser?.user_id, branchId);
        // A starter prompt is written to exercise the server it ships with, so
        // it is only worth arming the composer with once that server can answer
        // it. A new OAuth install with no reusable grant lands without
        // credentials: staging the prompt there hands the user a loaded
        // composer whose only outcome is a tool-less answer, turning a
        // recoverable state into an invitation to hit the failure. The session
        // says what is missing instead — see the unauthenticated-server notice
        // above the composer and the warning MCP badge beside it.
        if (
          result.starter_prompt &&
          !mcpServerNeedsAuth(result.mcp_server, userAuthenticatedMcpServerIds)
        ) {
          savePromptDraft(currentUser?.user_id, result.session.session_id, result.starter_prompt);
        }
        setSelected(null);
        navigate(sessionPath(result.session.session_id));
      } catch (err: unknown) {
        if (!operation.isCurrent()) return;
        setConnectError(err instanceof Error ? err.message : 'Could not connect this server');
        // The catalog file is presentational; the endpoint decides. When those
        // disagree the daemon says so on the refusal, and taking it here is
        // what turns a dead end — a form demanding a key the endpoint no longer
        // wants, or offering none where it now does — into one more attempt.
        // Left alone when the refusal carries no requirement, so an unrelated
        // failure does not reshape the form.
        const requirement = readCredentialRequirement(err);
        if (requirement) setKeyRequirement(requirement);
      } finally {
        if (operation.isCurrent()) setConnecting(false);
      }
    },
    [
      client,
      currentUser?.user_id,
      navigate,
      operationGuard,
      selected,
      userAuthenticatedMcpServerIds,
    ]
  );

  return (
    <Flex vertical gap={token.margin}>
      <CatalogToolbar
        search={filters.search}
        category={filters.category}
        capability={filters.capability}
        sort={filters.sort}
        onSearchChange={onSearchChange}
        onCategoryChange={onCategoryChange}
        onCapabilityChange={onCapabilityChange}
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
        identityKey={currentUser?.user_id ?? null}
        entry={selected}
        open={selected !== null}
        onClose={closeDrawer}
        branches={branches}
        branchesLoading={branchesLoading}
        branchesError={branchesError}
        defaultBranchId={getLastConnectBranchId(currentUser?.user_id)}
        connecting={connecting}
        connectError={connectError}
        credentialRequirement={keyRequirement}
        connectCapability={connectCapability}
        policyPending={policyPending}
        policyPendingHint={policyPendingHint}
        onConnect={handleConnect}
      />
    </Flex>
  );
};

/**
 * The catalog grid itself is public workspace data, but its active drawer,
 * refusal/error state, endpoint requirement, and in-flight interaction all
 * belong to the authenticated caller. Replacing A with B remounts that state
 * owner synchronously; same-user reconnects and token rotations retain it.
 */
export const CatalogTab: React.FC<CatalogTabProps> = (props) => (
  <CatalogTabForIdentity
    key={props.currentUser?.user_id ?? '__no-authenticated-user__'}
    {...props}
  />
);
