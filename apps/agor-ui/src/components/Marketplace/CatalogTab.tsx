/**
 * The Catalog: browse the MCP catalog, open an entry, connect it.
 *
 * The whole catalog arrives in one read, so filtering, ordering and paging all
 * happen over what the browser holds — see `useCatalogSearch`. The grid still
 * renders one page at a time; only the round trip per page is gone.
 */

import type {
  AgenticToolName,
  BranchID,
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
import { stagePromptDraftSeed } from '../../utils/promptDrafts';
import { type MCPServerCapabilityContext, policyPendingState } from '../MCPServer/memberPolicy';
import { CatalogCard } from './CatalogCard';
import { CatalogDetailDrawer } from './CatalogDetailDrawer';
import { CatalogToolbar } from './CatalogToolbar';
import { DEFAULT_SORT } from './catalogPresentation';
import {
  MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS,
  MARKETPLACE_OAUTH_POLL_DELAYS_MS,
} from './marketplaceLayout';
import {
  catalogConnectNeedsAuthentication,
  launchMarketplaceOAuth,
} from './marketplaceOAuthLaunch';
import type { MarketplaceOAuthPopup } from './marketplaceOAuthPopup';
import { marketplaceCredentialIsUsable } from './marketplacePresentation';
import { useCatalogReadiness } from './useCatalogReadiness';
import {
  CATALOG_PAGE_SIZE,
  type CatalogFilterState,
  isFilterActive,
  useCatalogSearch,
} from './useCatalogSearch';
import { useSessionTeammates } from './useSessionTeammates';

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
  /** Explicit connection-only owner. Never prepares a workspace or starts a tryout. */
  context?:
    | { mode: 'catalog' }
    | {
        mode: 'onboarding';
        entryName: string;
        onClose: () => void;
        onConnected: (serverId: string) => void;
      };
  /** Whether this tab is the active tab; inactive drawers must not portal over another tab. */
  active?: boolean;
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
  onOpenSession?: (sessionId: SessionID) => void;
  refreshMarketplaceOverview?: () => Promise<unknown>;
}

const CatalogTabForIdentity: React.FC<CatalogTabProps> = ({
  active = true,
  context,
  client,
  connected,
  connecting: connectionPending,
  authGeneration,
  currentUser,
  refreshMarketplaceOverview,
  onOpenSession,
}) => {
  const onboarding = context?.mode === 'onboarding' ? context : undefined;
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<CatalogFilterState>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MCPCatalogEntry | null>(null);
  const drawerOpen = useRef(false);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const drawerFocusTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(drawerFocusTimer.current);
      drawerTrigger.current = null;
    },
    []
  );
  const [connecting, setConnecting] = useState(false);
  const [sessionSetupRequested, setSessionSetupRequested] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const [startSessionError, setStartSessionError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState<{
    catalogKey: string;
    serverId: string;
    starterPrompt?: string;
    authentication: 'ready' | 'action_required' | 'pending' | 'failed' | 'unknown';
    reusedExistingServer: boolean;
    oauthAttemptId?: string;
  } | null>(null);
  const interactionEpoch = useRef(0);
  const startingSessionRef = useRef(false);
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

  useEffect(() => {
    if (active) return;
    interactionEpoch.current += 1;
    startingSessionRef.current = false;
    drawerOpen.current = false;
    drawerTrigger.current = null;
    setSelected(null);
    setConnecting(false);
    setStartingSession(false);
    setSessionSetupRequested(false);
    setStartSessionError(null);
    setConnectError(null);
    setConnectSuccess(null);
    setKeyRequirement(null);
    surpriseOAuthResultRef.current = null;
  }, [active]);

  const { entries, allEntries, status, matchCount, catalogSize, error, retry } = useCatalogSearch(
    client,
    connected,
    filters,
    page
  );
  const sessionTeammates = useSessionTeammates(
    client,
    !onboarding &&
      active &&
      connected &&
      !connectionPending &&
      sessionSetupRequested &&
      connectSuccess !== null,
    currentUser ? `${currentUser.user_id}:${authGeneration}` : undefined
  );
  // `connected` deliberately stays true during disconnect grace, while a token
  // replacement keeps the same client object. Neither may preserve an enabled
  // action: capability reads are scoped to the authenticated generation and
  // connectionReady closes synchronously for both transitions.
  const connectionReady = connected && !connectionPending;
  // A lost authentication generation invalidates in-flight work, but must not
  // leave the next generation's controls permanently spinning.
  // biome-ignore lint/correctness/useExhaustiveDependencies: an auth generation is an operation boundary
  useEffect(() => {
    startingSessionRef.current = false;
    setStartingSession(false);
    setConnecting(false);
  }, [authGeneration, connectionReady]);
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
    active && connectionReady && currentUser?.user_id && currentUser.role && !policyPending
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
      const authority = operationGuard.begin();
      const epoch = interactionEpoch.current;
      const operation = {
        isCurrent: () =>
          authority.isCurrent() && drawerOpen.current && interactionEpoch.current === epoch,
      };
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
    interactionEpoch.current += 1;
    startingSessionRef.current = false;
    drawerOpen.current = true;
    drawerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConnecting(false);
    setConnectError(null);
    setConnectSuccess(null);
    setStartSessionError(null);
    setStartingSession(false);
    setSessionSetupRequested(false);
    surpriseOAuthResultRef.current = null;
    // A requirement learned about one entry says nothing about the next.
    setKeyRequirement(null);
    setSelected(entry);
  }, []);

  const handoffConsumed = useRef(false);
  useEffect(() => {
    if (
      handoffConsumed.current ||
      !onboarding?.entryName ||
      !active ||
      !connectionReady ||
      status !== 'ready'
    )
      return;
    const entry = allEntries.find((item) => item.name === onboarding.entryName);
    if (entry) {
      handoffConsumed.current = true;
      openEntry(entry);
    }
    // A missing entry may become available after Retry; never guess an endpoint.
  }, [onboarding, active, connectionReady, status, allEntries, openEntry]);

  const restoreDrawerFocus = useCallback((trigger: HTMLElement | null) => {
    if (drawerOpen.current || !trigger?.isConnected || drawerTrigger.current !== trigger) return;
    window.clearTimeout(drawerFocusTimer.current);
    drawerTrigger.current = null;
    trigger.focus();
  }, []);

  const closeDrawer = useCallback(() => {
    interactionEpoch.current += 1;
    startingSessionRef.current = false;
    drawerOpen.current = false;
    const trigger = drawerTrigger.current;
    setConnecting(false);
    setStartingSession(false);
    setSessionSetupRequested(false);
    setStartSessionError(null);
    setKeyRequirement(null);
    setSelected(null);
    setConnectError(null);
    setConnectSuccess(null);
    surpriseOAuthResultRef.current = null;
    // `afterOpenChange(false)` is the normal restoration boundary. Keep a
    // guarded fallback for browsers that cancel the exit motion after Escape
    // (for example when reduced-motion state changes during the animation).
    window.clearTimeout(drawerFocusTimer.current);
    drawerFocusTimer.current = window.setTimeout(
      () => restoreDrawerFocus(trigger),
      MARKETPLACE_DRAWER_FOCUS_FALLBACK_MS
    );
    onboarding?.onClose();
  }, [restoreDrawerFocus, onboarding]);

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
      acknowledgedDisclosure,
      bearerToken,
      oauthPopup,
    }: {
      acknowledgedDisclosure: string;
      bearerToken?: string;
      oauthPopup?: MarketplaceOAuthPopup;
    }) => {
      const authority = operationGuard.begin();
      const epoch = interactionEpoch.current;
      const operation = {
        isCurrent: () =>
          authority.isCurrent() && drawerOpen.current && interactionEpoch.current === epoch,
      };
      if (!selected || !client || !operation.isCurrent()) {
        oauthPopup?.close();
        return;
      }
      setConnecting(true);
      setConnectError(null);
      try {
        const result = await client.service('mcp-catalog/connect').create({
          catalog_key: selected.name,
          acknowledged_disclosure: acknowledgedDisclosure,
          ...(bearerToken ? { bearer_token: bearerToken } : {}),
        });
        if (!operation.isCurrent()) {
          oauthPopup?.close();
          return;
        }

        const needsAuthentication = catalogConnectNeedsAuthentication(result);
        let authentication: 'ready' | 'action_required' | 'pending' | 'failed' | 'unknown' =
          'ready';
        let oauthAttemptId: string | undefined;
        if (needsAuthentication) {
          if (oauthPopup && result.mcp_server.auth?.type === 'oauth') {
            try {
              const launched = await launchMarketplaceOAuth(client, result, oauthPopup, {
                isCurrent: operation.isCurrent,
              });
              if (!launched && operation.isCurrent()) {
                authentication = 'failed';
                message.warning(
                  onboarding
                    ? 'Sign-in could not start automatically. Retry here when ready.'
                    : 'Sign-in could not start automatically. Retry from My Servers when ready.'
                );
              }
              oauthAttemptId = launched?.attemptId;
              if (oauthAttemptId) authentication = 'pending';
              if (!operation.isCurrent()) {
                oauthPopup.close();
                return;
              }
            } catch (cause) {
              oauthPopup.close();
              if (!operation.isCurrent()) return;
              authentication = 'failed';
              message.error(
                onboarding
                  ? 'Sign-in could not open. Return to onboarding or retry here.'
                  : cause instanceof Error
                    ? cause.message
                    : 'Sign-in could not open. Retry from My Servers when ready.'
              );
            }
          } else if (result.mcp_server.auth?.type === 'oauth') {
            authentication = 'action_required';
            surpriseOAuthResultRef.current = result;
          } else {
            authentication = 'unknown';
            oauthPopup?.close();
          }
        } else {
          oauthPopup?.close();
        }
        setConnectSuccess({
          catalogKey: selected.name,
          serverId: result.mcp_server.mcp_server_id,
          ...(result.starter_prompt ? { starterPrompt: result.starter_prompt } : {}),
          authentication,
          reusedExistingServer: result.reused_existing_server,
          ...(oauthAttemptId ? { oauthAttemptId } : {}),
        });
      } catch (err: unknown) {
        oauthPopup?.close();
        if (!operation.isCurrent()) return;
        setConnectError(
          onboarding
            ? 'Could not connect this server. Check your credentials and try again.'
            : err instanceof Error
              ? err.message
              : 'Could not connect this server'
        );
        const requirement = readCredentialRequirement(err);
        if (requirement) setKeyRequirement(requirement);
      } finally {
        if (operation.isCurrent()) setConnecting(false);
      }
    },
    [client, operationGuard, selected, onboarding]
  );

  const continueSurpriseOAuth = useCallback(
    async (oauthPopup: MarketplaceOAuthPopup) => {
      const authority = operationGuard.begin();
      const epoch = interactionEpoch.current;
      const operation = {
        isCurrent: () =>
          authority.isCurrent() && drawerOpen.current && interactionEpoch.current === epoch,
      };
      const result = surpriseOAuthResultRef.current;
      const current = connectSuccessRef.current;
      if (
        !client ||
        !result ||
        current?.authentication !== 'action_required' ||
        current.serverId !== result.mcp_server.mcp_server_id ||
        !operation.isCurrent()
      ) {
        oauthPopup.close();
        return;
      }

      setConnecting(true);
      try {
        const launched = await launchMarketplaceOAuth(client, result, oauthPopup, {
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
          onboarding
            ? 'Sign-in could not open. Return to onboarding or retry here.'
            : cause instanceof Error
              ? cause.message
              : 'Sign-in could not open. Retry from My Servers when ready.'
        );
      } finally {
        if (operation.isCurrent()) setConnecting(false);
      }
    },
    [client, operationGuard, onboarding]
  );

  const handleStartSession = useCallback(
    async ({
      teammateBranchId,
      agenticTool,
    }: {
      teammateBranchId: BranchID;
      agenticTool: AgenticToolName;
    }) => {
      const authority = operationGuard.begin();
      const epoch = interactionEpoch.current;
      const operation = {
        isCurrent: () =>
          authority.isCurrent() && drawerOpen.current && interactionEpoch.current === epoch,
      };
      const current = connectSuccessRef.current;
      if (
        onboarding ||
        !client ||
        !currentUser ||
        !current ||
        !operation.isCurrent() ||
        startingSessionRef.current
      )
        return;
      startingSessionRef.current = true;
      setStartingSession(true);
      setStartSessionError(null);
      try {
        const result = await client.service('mcp-catalog/start-session').create({
          catalog_key: current.catalogKey,
          mcp_server_id: current.serverId,
          teammate_branch_id: teammateBranchId,
          agentic_tool: agenticTool,
        });
        if (!operation.isCurrent()) return;
        stagePromptDraftSeed(
          currentUser.user_id,
          result.session.session_id,
          result.starter_prompt ?? ''
        );
        if (onOpenSession) onOpenSession(result.session.session_id);
        else navigate(sessionPath(result.session.session_id));
      } catch (cause) {
        if (!operation.isCurrent()) return;
        setStartSessionError(
          cause instanceof Error ? cause.message : 'Could not start a session with this server'
        );
      } finally {
        if (operation.isCurrent()) {
          startingSessionRef.current = false;
          setStartingSession(false);
        }
      }
    },
    [client, currentUser, navigate, onOpenSession, operationGuard, onboarding]
  );

  const reportedConnections = useRef(new Set<string>());
  useEffect(() => {
    if (
      !onboarding ||
      !active ||
      !connectionReady ||
      connectSuccess?.authentication !== 'ready' ||
      reportedConnections.current.has(connectSuccess.serverId)
    )
      return;
    reportedConnections.current.add(connectSuccess.serverId);
    onboarding.onConnected(connectSuccess.serverId);
  }, [onboarding, active, connectionReady, connectSuccess]);

  const drawers = (
    <>
      <CatalogDetailDrawer
        mode={onboarding ? 'onboarding' : 'catalog'}
        onRetryConnection={() => {
          interactionEpoch.current += 1;
          setConnectSuccess(null);
          setConnectError(null);
          surpriseOAuthResultRef.current = null;
        }}
        identityKey={currentUser?.user_id ?? null}
        entry={selected}
        open={Boolean(onboarding) || selected !== null}
        emptyContent={
          onboarding && (
            <>
              {status === 'loading' ? (
                <Skeleton active aria-label="Loading Catalog" />
              ) : (
                <Alert
                  type="warning"
                  title={
                    status === 'error'
                      ? 'Could not load Catalog'
                      : 'This tool is not currently in Catalog'
                  }
                  action={<Button onClick={retry}>Retry</Button>}
                />
              )}
              <Button onClick={onboarding.onClose}>Return to onboarding</Button>
            </>
          )
        }
        onClose={closeDrawer}
        onAfterOpenChange={handleDrawerOpenChange}
        teammates={sessionTeammates.teammates}
        teammatesLoading={sessionTeammates.loading}
        teammatesError={sessionTeammates.error}
        defaultTeammateId={sessionTeammates.preferredTeammateId}
        startingSession={startingSession}
        startSessionError={startSessionError}
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
        onKeepBrowsing={closeDrawer}
        onBeginSessionSetup={onboarding ? undefined : () => setSessionSetupRequested(true)}
        onStartSession={onboarding ? undefined : handleStartSession}
        onContinueOAuth={continueSurpriseOAuth}
        onConnect={handleConnect}
      />
    </>
  );
  if (onboarding) return drawers;

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
          title="Not connected to the Agor daemon"
          description="The catalog will load as soon as the connection is back."
        />
      )}

      {/* `empty` is only reachable from a read that returned. A failed read
          renders as a failure, never as a catalog with nothing in it. */}
      {status === 'error' ? (
        <Alert
          type="error"
          showIcon
          title="Could not load the catalog"
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

      {drawers}
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
    key={`${props.context?.mode ?? 'catalog'}:${props.currentUser?.user_id ?? '__no-authenticated-user__'}`}
    {...props}
  />
);
