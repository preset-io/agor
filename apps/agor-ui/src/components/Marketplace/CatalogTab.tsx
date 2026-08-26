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
  MCPCatalogConnectResult,
  MCPCatalogCredentialRequirement,
  MCPCatalogEntry,
  MCPMarketplaceOverview,
  SessionID,
} from '@agor/core/types';
import { readCredentialRequirement } from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import { hasMinimumRole, ROLES, sessionPath } from '@agor-live/client';
import { Alert, Button, Col, Empty, Flex, message, Pagination, Row, Skeleton, theme } from 'antd';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useMcpMemberPolicy } from '../../hooks/useMcpMemberPolicy';
import { useAgorStore } from '../../store/agorStore';
import { selectUserAuthenticatedMcpServerIds } from '../../store/selectors';
import { saveMarketplacePromptSuggestion } from '../../utils/marketplaceOAuthPrompt';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { type MCPServerCapabilityContext, policyPendingState } from '../MCPServer/memberPolicy';
import { CatalogCard } from './CatalogCard';
import { CatalogDetailDrawer } from './CatalogDetailDrawer';
import { CatalogToolbar } from './CatalogToolbar';
import { DEFAULT_SORT } from './catalogPresentation';
import {
  MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS,
  MARKETPLACE_OAUTH_POLL_DELAYS_MS,
} from './marketplaceLayout';
import { launchMarketplaceOAuth } from './marketplaceOAuthLaunch';
import type { MarketplaceOAuthPopup } from './marketplaceOAuthPopup';
import { marketplaceCredentialIsUsable } from './marketplacePresentation';
import { useCatalogReadiness } from './useCatalogReadiness';
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
  /** Refresh the shared four-tab projection after durable OAuth confirmation. */
  refreshMarketplaceOverview?: () => Promise<unknown>;
}

const CatalogTabForIdentity: React.FC<CatalogTabProps> = ({
  client,
  connected,
  connecting: connectionPending,
  authGeneration,
  currentUser,
  refreshMarketplaceOverview,
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
  const drawerOpen = useRef(false);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState<{
    sessionId: SessionID;
    sessionTitle?: string;
    branchName?: string;
    authentication: 'ready' | 'action_required' | 'pending' | 'failed' | 'unknown';
    reusedExistingServer: boolean;
    serverId?: string;
    oauthAttemptId?: string;
  } | null>(null);
  const connectSuccessRef = useRef(connectSuccess);
  connectSuccessRef.current = connectSuccess;
  // A live probe can discover OAuth after advisory readiness said an endpoint
  // was open. Preserve the redacted connect result only long enough for a
  // direct user gesture to open the provider window and create the durable
  // attempt. Never manufacture a pending state when neither exists.
  const surpriseOAuthResultRef = useRef<MCPCatalogConnectResult | null>(null);
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
  const readiness = useCatalogReadiness({
    client,
    entryKey: selected?.name,
    ready: connectionReady,
    authGeneration,
    userId: currentUser?.user_id,
  });

  const confirmOAuthGrant = useCallback(
    async (attemptId: string, serverId: string) => {
      const operation = operationGuard.begin();
      if (!client || !operation.isCurrent()) return false;
      try {
        const refreshed = await refreshMarketplaceOverview?.();
        const fresh: MCPMarketplaceOverview =
          refreshed && typeof refreshed === 'object' && 'credentials' in refreshed
            ? (refreshed as MCPMarketplaceOverview)
            : ((await client.service('mcp-marketplace').find()) as MCPMarketplaceOverview);
        if (!operation.isCurrent()) return false;
        const credential = fresh.credentials.find(
          (item) => item.mcp_server_id === serverId && marketplaceCredentialIsUsable(item)
        );
        const serverEnabled = fresh.servers.some(
          (item) => item.mcp_server_id === serverId && item.enabled
        );
        const current = connectSuccessRef.current;
        if (
          !credential ||
          !serverEnabled ||
          current?.oauthAttemptId !== attemptId ||
          current.serverId !== serverId
        ) {
          return false;
        }
        setConnectSuccess({ ...current, authentication: 'ready' });
        return true;
      } catch {
        // Realtime completion is only a latency hint. If the caller-scoped
        // credential projection cannot confirm the saved grant, stay pending.
        return false;
      }
    },
    [client, operationGuard, refreshMarketplaceOverview]
  );

  useEffect(() => {
    if (!client) return;
    const onCompleted = (event: {
      attempt_id?: string;
      mcp_server_id?: string;
      success?: boolean;
    }) => {
      const current = connectSuccessRef.current;
      if (
        !current?.oauthAttemptId ||
        event.attempt_id !== current.oauthAttemptId ||
        event.mcp_server_id !== current.serverId
      ) {
        return;
      }
      if (event.success === true) void confirmOAuthGrant(current.oauthAttemptId, current.serverId!);
      // A false realtime packet is only a latency hint: the durable attempt
      // distinguishes a definite provider failure from an ambiguous exchange.
    };
    client.io.on('oauth:completed', onCompleted);
    return () => {
      client.io.off('oauth:completed', onCompleted);
    };
  }, [client, confirmOAuthGrant]);

  // Close the small race where callback completion can beat the pending-panel
  // commit. This durable attempt read may confirm failure or trigger a fresh
  // credential read; it never treats popup navigation as authentication.
  useEffect(() => {
    const current = connectSuccess;
    if (!client || current?.authentication !== 'pending' || !current.oauthAttemptId) return;
    const attemptId = current.oauthAttemptId;
    let cancelled = false;
    let pollTimer: number | undefined;
    const wait = (delay: number) =>
      new Promise<void>((resolve) => {
        pollTimer = window.setTimeout(resolve, delay);
      });
    void (async () => {
      for (const delay of [0, ...MARKETPLACE_OAUTH_POLL_DELAYS_MS]) {
        if (delay) await wait(delay);
        if (cancelled || connectSuccessRef.current?.oauthAttemptId !== attemptId) return;
        try {
          const raw = await client.service('mcp-servers/oauth-attempt-status').get(attemptId);
          const attempt = raw as { status?: string; mcp_server_id?: string };
          if (cancelled || connectSuccessRef.current?.oauthAttemptId !== attemptId) return;
          if (attempt.status === 'succeeded' && attempt.mcp_server_id === current.serverId) {
            if (await confirmOAuthGrant(attemptId, current.serverId!)) return;
            continue;
          }
          if (attempt.status === 'failed') {
            setConnectSuccess((value) =>
              value?.oauthAttemptId === attemptId ? { ...value, authentication: 'failed' } : value
            );
            return;
          }
          if (attempt.status === 'ambiguous') {
            setConnectSuccess((value) =>
              value?.oauthAttemptId === attemptId ? { ...value, authentication: 'unknown' } : value
            );
            return;
          }
        } catch {
          // Keep polling within the bounded schedule. A missed/unavailable
          // status read is never failure evidence.
        }
      }
      if (!cancelled) {
        setConnectSuccess((value) =>
          value?.oauthAttemptId === attemptId ? { ...value, authentication: 'unknown' } : value
        );
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
    };
  }, [client, confirmOAuthGrant, connectSuccess]);

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
    drawerOpen.current = true;
    drawerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConnectError(null);
    setConnectSuccess(null);
    surpriseOAuthResultRef.current = null;
    // A requirement learned about one entry says nothing about the next.
    setKeyRequirement(null);
    setSelected(entry);
  }, []);

  const restoreDrawerFocus = useCallback((trigger: HTMLElement | null) => {
    if (drawerOpen.current || !trigger?.isConnected || drawerTrigger.current !== trigger) return;
    trigger.focus();
  }, []);

  const closeDrawer = useCallback(() => {
    drawerOpen.current = false;
    const trigger = drawerTrigger.current;
    setKeyRequirement(null);
    setSelected(null);
    setConnectError(null);
    setConnectSuccess(null);
    surpriseOAuthResultRef.current = null;
    // `afterOpenChange(false)` is the normal restoration boundary. Keep a
    // guarded fallback for browsers that cancel the exit motion after Escape
    // (for example when reduced-motion state changes during the animation).
    window.setTimeout(() => restoreDrawerFocus(trigger), MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS);
  }, [restoreDrawerFocus]);

  const handleDrawerOpenChange = useCallback(
    (open: boolean) => {
      // A close transition may finish after a rapid close/reopen. That older
      // animation must not consume the new interaction's trigger.
      if (open || drawerOpen.current) return;
      const trigger = drawerTrigger.current;
      restoreDrawerFocus(trigger);
    },
    [restoreDrawerFocus]
  );

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
      oauthPopup,
    }: {
      branchId: string;
      agenticTool: AgenticToolName;
      acknowledgedDisclosure: string;
      bearerToken?: string;
      oauthPopup?: MarketplaceOAuthPopup;
    }) => {
      const operation = operationGuard.begin();
      if (!selected || !client || !operation.isCurrent()) {
        oauthPopup?.close();
        return;
      }
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
        if (!operation.isCurrent()) {
          oauthPopup?.close();
          return;
        }
        rememberConnectBranchId(currentUser?.user_id, branchId);
        // Present the starter prompt only once this server can answer it. It is
        // a tab-local suggestion, not an automatic write into the cross-tab
        // composer draft. A new OAuth install without a reusable grant instead
        // lands on the recoverable authentication notice and warning MCP badge.
        const needsAuthentication = mcpServerNeedsAuth(
          result.mcp_server,
          userAuthenticatedMcpServerIds
        );
        if (result.starter_prompt && !needsAuthentication) {
          saveMarketplacePromptSuggestion({
            sessionId: result.session.session_id,
            prompt: result.starter_prompt,
            authority: {
              userId: currentUser!.user_id,
              role: currentUser!.role,
              authGeneration,
            },
          });
        }

        let authentication: 'ready' | 'action_required' | 'pending' | 'failed' | 'unknown' =
          'ready';
        let oauthAttemptId: string | undefined;
        if (needsAuthentication) {
          if (oauthPopup && result.mcp_server.auth?.type === 'oauth') {
            try {
              const launched = await launchMarketplaceOAuth(client, result, oauthPopup, {
                authority: {
                  userId: currentUser!.user_id,
                  role: currentUser!.role,
                  authGeneration,
                },
                isCurrent: operation.isCurrent,
              });
              if (!launched && operation.isCurrent()) {
                authentication = 'failed';
                message.warning(
                  'Sign-in could not start automatically. Continue from MCP settings in the new session.'
                );
              }
              oauthAttemptId = launched?.attemptId;
              if (oauthAttemptId) authentication = 'pending';
              if (!operation.isCurrent()) {
                oauthPopup.close();
                return;
              }
            } catch (cause) {
              // The server and session now exist. Land in the recoverable
              // session rather than pretending the whole Connect failed.
              oauthPopup.close();
              if (!operation.isCurrent()) return;
              authentication = 'failed';
              message.error(
                cause instanceof Error
                  ? cause.message
                  : 'Sign-in could not open. Continue from MCP settings in the new session.'
              );
            }
          } else if (result.mcp_server.auth?.type === 'oauth') {
            // Readiness is advisory. A formerly-open endpoint can race to
            // OAuth after the click that did not pre-open a popup. Do not call
            // that pending: there is no window or durable attempt yet. Retain
            // the redacted result so a new, explicit user gesture can create
            // both safely.
            authentication = 'action_required';
            surpriseOAuthResultRef.current = result;
          } else {
            authentication = 'unknown';
            oauthPopup?.close();
          }
        } else {
          oauthPopup?.close();
        }
        const connectedBranch = branches.find((branch) => branch.branch_id === branchId);
        setConnectSuccess({
          sessionId: result.session.session_id,
          ...(result.session.title ? { sessionTitle: result.session.title } : {}),
          ...(connectedBranch ? { branchName: connectedBranch.name as string } : {}),
          authentication,
          reusedExistingServer: result.reused_existing_server,
          ...(needsAuthentication
            ? {
                serverId: result.mcp_server.mcp_server_id,
                ...(oauthAttemptId ? { oauthAttemptId } : {}),
              }
            : {}),
        });
      } catch (err: unknown) {
        oauthPopup?.close();
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
      authGeneration,
      branches,
      currentUser,
      currentUser?.user_id,
      operationGuard,
      selected,
      userAuthenticatedMcpServerIds,
    ]
  );

  const continueSurpriseOAuth = useCallback(
    async (oauthPopup: MarketplaceOAuthPopup) => {
      const operation = operationGuard.begin();
      const result = surpriseOAuthResultRef.current;
      const current = connectSuccessRef.current;
      if (
        !client ||
        !result ||
        current?.authentication !== 'action_required' ||
        current.serverId !== result.mcp_server.mcp_server_id ||
        current.sessionId !== result.session.session_id ||
        !operation.isCurrent()
      ) {
        oauthPopup.close();
        return;
      }

      setConnecting(true);
      try {
        const launched = await launchMarketplaceOAuth(client, result, oauthPopup, {
          authority: {
            userId: currentUser!.user_id,
            role: currentUser!.role,
            authGeneration,
          },
          isCurrent: operation.isCurrent,
        });
        if (!operation.isCurrent()) {
          oauthPopup.close();
          return;
        }
        if (!launched?.attemptId) {
          setConnectSuccess((value) =>
            value?.authentication === 'action_required'
              ? { ...value, authentication: 'failed' }
              : value
          );
          return;
        }
        surpriseOAuthResultRef.current = null;
        setConnectSuccess((value) =>
          value?.authentication === 'action_required' &&
          value.serverId === result.mcp_server.mcp_server_id
            ? { ...value, authentication: 'pending', oauthAttemptId: launched.attemptId }
            : value
        );
      } catch (cause) {
        oauthPopup.close();
        if (!operation.isCurrent()) return;
        setConnectSuccess((value) =>
          value?.authentication === 'action_required'
            ? { ...value, authentication: 'failed' }
            : value
        );
        message.error(
          cause instanceof Error
            ? cause.message
            : 'Sign-in could not open. Continue from MCP settings in the new session.'
        );
      } finally {
        if (operation.isCurrent()) setConnecting(false);
      }
    },
    [authGeneration, client, currentUser, operationGuard]
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
        onAfterOpenChange={handleDrawerOpenChange}
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
        readiness={readiness.readiness}
        readinessLoading={readiness.loading}
        readinessError={readiness.error}
        success={connectSuccess}
        onOpenSession={(sessionId) => navigate(sessionPath(sessionId))}
        onContinueOAuth={continueSurpriseOAuth}
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
