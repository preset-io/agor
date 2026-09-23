import type { AgorClient, Branch, Session, SessionID, SpawnConfig, User } from '@agor-live/client';
import {
  getGatewaySource as getGatewaySourceCore,
  isGatewaySession as isGatewaySessionCore,
  isSessionExecuting,
  SessionStatus,
} from '@agor-live/client';
import {
  ArrowUpOutlined,
  ClockCircleOutlined,
  DisconnectOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  EyeOutlined,
  LinkOutlined,
  MessageOutlined,
  MinusSquareOutlined,
  PlusOutlined,
  PlusSquareOutlined,
  RightOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  App,
  Badge,
  Button,
  Collapse,
  ConfigProvider,
  Flex,
  Space,
  Spin,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { ARCHIVE_REFRESH_WARNING, useSessionActions } from '../../hooks/useSessionActions';
import { useStableCallback } from '../../hooks/useStableCallback';
import {
  type BranchSectionKey,
  COLLAPSED_BRANCH_NODES_STORAGE_KEY,
  type CollapsedBranchNode,
  type CollapsedBranchNodes,
  EMPTY_COLLAPSED_BRANCH_NODE,
  EMPTY_COLLAPSED_BRANCH_NODES,
  setCollapsedBranchNode,
} from '../../utils/collapsedBranchNodes';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { useThemedMessage } from '../../utils/message';
import {
  getMatchSnippet,
  isSessionSearchActive,
  SESSION_SORT_STORAGE_KEY,
  type SessionSort,
  searchSessions,
  sessionToolMatches,
  sortSessions,
} from '../../utils/sessionSearch';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { ArchiveActionButton } from '../ArchiveButton';
import { type ForkSpawnAction, ForkSpawnModal } from '../ForkSpawnModal';
import { HighlightMatch } from '../HighlightMatch';
import { ChannelPill, getChannelIcon } from '../Pill';
import { SessionRelationshipIcon } from '../SessionRelationshipIcon';
import {
  SessionRelevanceLabel,
  SessionSearchToolbar,
  SessionSortButton,
} from '../SessionSearchControls';
import { ToolIcon } from '../ToolIcon';
import { BranchSessionTree } from './BranchSessionTree';
import {
  buildSessionTree,
  collectSessionSubtreeIds,
  type SessionTreeNode,
} from './buildSessionTree';
import { PagedSessions } from './PagedSessions';

// Stable theme object so the ConfigProvider context value doesn't churn.
const NO_MOTION_THEME = { token: { motion: false } };

const SECTION_KEYS: BranchSectionKey[] = ['sessions', 'scheduled-runs', 'gateway-sessions'];
const PANEL_AGENT_ICON_SIZE = 16;
const PANEL_STATUS_DOT_SIZE = 6;
/** Revealed rows animate in with a short stagger; later rows share the last delay. */
const ROW_ENTER_STAGGER_MS = 15;
const ROW_ENTER_MAX_STAGGER = 8;
const ROW_ENTER_CLEAR_MS = 400;
const EMPTY_ENTERING_ROWS: ReadonlyMap<string, number> = new Map();

const isSessionFailed = (session: Session): boolean => session.status === SessionStatus.FAILED;

function getSessionRowAccessibleLabel(
  session: Session,
  panel?: { hiddenChildCount?: number }
): string {
  const details = [
    `Open session ${getSessionDisplayTitle(session, { includeAgentFallback: true })}`,
  ];

  if (session.remote_surrogate) {
    details.push('remote session', 'opens in its own branch');
  }
  // Panel rows show these only as a status mark or count, so the name must carry them.
  if (panel && isSessionExecuting(session)) {
    details.push('running');
  } else if (isSessionFailed(session)) {
    details.push('latest task failed');
  } else if (panel && session.ready_for_prompt) {
    details.push('ready for prompt');
  }
  if (panel?.hiddenChildCount) {
    const { hiddenChildCount } = panel;
    details.push(`${hiddenChildCount} hidden child session${hiddenChildCount === 1 ? '' : 's'}`);
  }

  return details.join('; ');
}

export type BranchSessionSectionsMode = 'card' | 'panel';
type CollapseKey = string | number;
type RemoteRelationshipRef = {
  relationship_type?: string;
  source_session_id?: string;
};

export interface BranchSessionSectionsProps {
  branch: Branch;
  sessions: Session[];
  userById: Map<string, User>;
  currentUserId?: string;
  selectedSessionId?: string | null;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (branchId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onOpenSessionSettings?: (sessionId: string) => void;
  peekedSessionIds?: Set<string>;
  onTogglePeekSession?: (sessionId: string) => void;
  mode?: BranchSessionSectionsMode;
  /** The caller supplies a bounded flex-column container (not an auto-sized card). */
  fillAvailableHeight?: boolean;
  client: AgorClient | null;
}

/** Wrapper that adds hover action buttons (settings + archive) overlay to session items */
const SessionItemWithActions: React.FC<{
  sessionId: string;
  isArchiving: boolean;
  isPeeked?: boolean;
  /** Paint a hover surface for rows that are not inside Tree, which supplies its own. */
  hoverFill?: boolean;
  /** Mount the toolbar in idle time (or on first hover/focus) so expanding many rows stays cheap. */
  deferActions?: boolean;
  onArchive: (sessionId: string, e: React.MouseEvent) => void;
  onSettings?: (sessionId: string, e: React.MouseEvent) => void;
  onTogglePeek?: (sessionId: string, e: React.MouseEvent) => void;
  onToggleCallback?: (sessionId: string, e: React.MouseEvent) => void;
  onOpenRemoteParent?: (sessionId: string, e: React.MouseEvent) => void;
  callbackToggle?: {
    enabled: boolean;
    disabled?: boolean;
    tooltip: string;
  };
  remoteParentLink?: {
    disabled?: boolean;
    tooltip: string;
  };
  children: React.ReactNode;
}> = ({
  sessionId,
  isArchiving,
  isPeeked = false,
  hoverFill = false,
  deferActions = false,
  onArchive,
  onSettings,
  onTogglePeek,
  onToggleCallback,
  onOpenRemoteParent,
  callbackToggle,
  remoteParentLink,
  children,
}) => {
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const { token } = theme.useToken();
  const showActions = hovered || focusWithin;
  // Once revealed, stay mounted so the fade-out and focus order behave as before.
  const [actionsRevealed, setActionsRevealed] = useState(!deferActions);
  // Idle-time mount keeps the toolbar in the accessibility tree for browse-mode screen readers.
  useEffect(() => {
    if (actionsRevealed) return;
    const reveal = () => setActionsRevealed(true);
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(reveal, { timeout: 1000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(reveal, 200);
    return () => clearTimeout(timer);
  }, [actionsRevealed]);

  const buttonStyle: React.CSSProperties = {
    background: `${token.colorBgContainer}cc`,
    borderRadius: 4,
    width: 24,
    height: 24,
    minWidth: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  const peekButtonStyle: React.CSSProperties = isPeeked
    ? {
        ...buttonStyle,
        color: token.colorPrimary,
        background: token.colorPrimaryBg,
      }
    : buttonStyle;

  return (
    <div
      style={{
        position: 'relative',
        minWidth: 0,
        width: '100%',
        ...(hoverFill
          ? {
              borderRadius: token.borderRadiusSM,
              background: showActions ? token.controlItemBgHover : undefined,
            }
          : undefined),
      }}
      onMouseEnter={() => {
        setHovered(true);
        setActionsRevealed(true);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => {
        setFocusWithin(true);
        setActionsRevealed(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusWithin(false);
        }
      }}
    >
      {children}
      {actionsRevealed && (
        <div
          style={{
            position: 'absolute',
            right: 4,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: showActions ? 1 : 0,
            transition: 'opacity 0.15s ease-in-out',
            pointerEvents: showActions ? 'auto' : 'none',
            display: 'flex',
            gap: 2,
            width: 'fit-content',
          }}
        >
          {onSettings && (
            <Tooltip title="Session settings">
              <Button
                type="text"
                size="small"
                icon={<SettingOutlined />}
                onClick={(e) => onSettings(sessionId, e)}
                style={buttonStyle}
              />
            </Tooltip>
          )}
          {onTogglePeek && (
            <Tooltip title={isPeeked ? 'Stop peeking at latest prompt' : 'Peek at latest prompt'}>
              <Button
                type="text"
                size="small"
                icon={<EyeOutlined />}
                onClick={(e) => onTogglePeek(sessionId, e)}
                style={peekButtonStyle}
              />
            </Tooltip>
          )}
          {onOpenRemoteParent && remoteParentLink && (
            <Tooltip title={remoteParentLink.tooltip}>
              <Button
                type="text"
                size="small"
                disabled={remoteParentLink.disabled}
                icon={<ArrowUpOutlined />}
                onClick={(e) => onOpenRemoteParent(sessionId, e)}
                style={{
                  ...buttonStyle,
                  color: token.colorTextSecondary,
                }}
              />
            </Tooltip>
          )}
          {onToggleCallback && callbackToggle && (
            <Tooltip title={callbackToggle.tooltip}>
              <Button
                type="text"
                size="small"
                disabled={callbackToggle.disabled}
                icon={callbackToggle.enabled ? <LinkOutlined /> : <DisconnectOutlined />}
                onClick={(e) => onToggleCallback(sessionId, e)}
                style={{
                  ...buttonStyle,
                  color: callbackToggle.enabled ? token.colorPrimary : token.colorTextTertiary,
                  background: callbackToggle.enabled
                    ? token.colorPrimaryBg
                    : buttonStyle.background,
                }}
              />
            </Tooltip>
          )}
          <ArchiveActionButton
            tooltip="Archive session"
            loading={isArchiving}
            onClick={(e) => onArchive(sessionId, e)}
            style={buttonStyle}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Tree re-renders every title on each expand/collapse and follow-up measurement.
 * Tree nodes are memoized, so a row re-renders only when its node or row inputs change.
 */
const MemoSessionTreeRow = memo(
  ({
    node,
    render,
    enterIndex,
    enterMotion,
  }: {
    node: SessionTreeNode;
    render: (node: SessionTreeNode) => React.ReactNode;
    rowInputs: readonly unknown[];
    /** Panel only: stagger slot while the row plays its reveal animation. */
    enterIndex?: number | null;
    /** Theme motion timing for the reveal; the stylesheet only names the keyframes. */
    enterMotion?: { duration: string; easing: string };
  }) =>
    enterIndex === undefined ? (
      render(node)
    ) : (
      // Opacity/transform keyframes run on the compositor, unlike Tree's height motion.
      <div
        className={enterIndex === null ? undefined : 'agor-session-row-enter'}
        style={
          enterIndex === null
            ? undefined
            : {
                animationDelay: `${Math.min(enterIndex, ROW_ENTER_MAX_STAGGER) * ROW_ENTER_STAGGER_MS}ms`,
                animationDuration: enterMotion?.duration,
                animationTimingFunction: enterMotion?.easing,
              }
        }
      >
        {render(node)}
      </div>
    ),
  (prev, next) =>
    prev.node === next.node &&
    prev.rowInputs.length === next.rowInputs.length &&
    prev.rowInputs.every((value, index) => Object.is(value, next.rowInputs[index]))
);

/** Cap a section at its actual content plus measured chrome, freeing space for siblings. */
function useTreeSectionHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number>();
  const onContentSizeChange = useCallback((contentHeight: number, viewportHeight: number) => {
    const sectionHeight = ref.current?.clientHeight;
    if (!sectionHeight) return;
    // Header/padding remain owned by Collapse/theme; do not duplicate their sizes.
    setMaxHeight(sectionHeight - viewportHeight + contentHeight);
  }, []);
  return { ref, maxHeight, onContentSizeChange };
}

export const BranchSessionSections: React.FC<BranchSessionSectionsProps> = ({
  branch,
  sessions,
  userById,
  currentUserId,
  selectedSessionId,
  onSessionClick,
  onCreateSession,
  onForkSession,
  onSpawnSession,
  onOpenSessionSettings,
  peekedSessionIds,
  onTogglePeekSession,
  mode = 'card',
  fillAvailableHeight = false,
  client,
}) => {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const { showSuccess, showError, showWarning } = useThemedMessage();
  const connectionDisabled = useConnectionDisabled();
  const isMobileViewport = useIsMobileViewport();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [enteringRows, setEnteringRows] = useState(EMPTY_ENTERING_ROWS);
  const enteringRowsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(enteringRowsTimer.current), []);
  const panelRowHeight = isMobileViewport ? MOBILE_TOUCH_TARGET : token.controlHeight;
  const { archiveSession: archiveSessionUnstable } = useSessionActions(client);
  // useSessionActions returns a new function per render; keep row handlers memo-stable.
  const archiveSession = useStableCallback(archiveSessionUnstable);

  const [forkSpawnModal, setForkSpawnModal] = useState<{
    open: boolean;
    action: ForkSpawnAction;
    session: Session | null;
  }>({
    open: false,
    action: 'fork',
    session: null,
  });
  const [archivingSessionIds, setArchivingSessionIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useLocalStorage<SessionSort>(SESSION_SORT_STORAGE_KEY, 'recent');

  const isPanel = mode === 'panel';
  const animatePanel = isPanel && token.motion !== false && !prefersReducedMotion;
  const fillPanel = isPanel && fillAvailableHeight;
  const manualTreeSection = useTreeSectionHeight();
  const gatewayTreeSection = useTreeSectionHeight();
  // Every collapsible node (sections + parent sessions in the tree) defaults
  // to expanded; only user-collapsed exceptions are kept. Board cards persist
  // them per branch in the shared collapsedBranchNodes store; the teammate
  // panel is a transient surface and must not rewrite the board card's stored
  // state, so it keeps ephemeral state instead.
  const [storedCollapsedNodes, setStoredCollapsedNodes] = useLocalStorage<CollapsedBranchNodes>(
    COLLAPSED_BRANCH_NODES_STORAGE_KEY,
    EMPTY_COLLAPSED_BRANCH_NODES
  );
  const [panelCollapsedNode, setPanelCollapsedNode] = useState<CollapsedBranchNode>(
    EMPTY_COLLAPSED_BRANCH_NODE
  );
  const collapsedNode = isPanel
    ? panelCollapsedNode
    : (storedCollapsedNodes[branch.branch_id] ?? EMPTY_COLLAPSED_BRANCH_NODE);
  const updateCollapsedNode = useCallback(
    (updater: (node: CollapsedBranchNode) => CollapsedBranchNode) => {
      if (isPanel) {
        setPanelCollapsedNode(updater);
        return;
      }
      setStoredCollapsedNodes((nodes) =>
        setCollapsedBranchNode(
          nodes,
          branch.branch_id,
          updater(nodes[branch.branch_id] ?? EMPTY_COLLAPSED_BRANCH_NODE)
        )
      );
    },
    [branch.branch_id, isPanel, setStoredCollapsedNodes]
  );
  const collapsedSections = collapsedNode.sections;
  const openSectionKeys = useMemo<CollapseKey[]>(
    () => SECTION_KEYS.filter((key) => !collapsedSections?.includes(key)),
    [collapsedSections]
  );
  const isManualSessionsOpen = !collapsedSections?.includes('sessions');
  const isScheduledRunsOpen = !collapsedSections?.includes('scheduled-runs');
  const isGatewaySessionsOpen = !collapsedSections?.includes('gateway-sessions');
  const updateSectionOpenState = useCallback(
    (sectionKey: BranchSectionKey, keys: CollapseKey | CollapseKey[]) => {
      const sectionIsOpen = Array.isArray(keys) ? keys.includes(sectionKey) : keys === sectionKey;
      updateCollapsedNode((node) => {
        const sections = new Set(node.sections ?? []);
        if (sectionIsOpen) sections.delete(sectionKey);
        else sections.add(sectionKey);
        return { ...node, sections: [...sections] };
      });
    },
    [updateCollapsedNode]
  );
  const handleManualSessionsChange = useCallback(
    (keys: CollapseKey | CollapseKey[]) => updateSectionOpenState('sessions', keys),
    [updateSectionOpenState]
  );
  const handleScheduledRunsChange = useCallback(
    (keys: CollapseKey | CollapseKey[]) => updateSectionOpenState('scheduled-runs', keys),
    [updateSectionOpenState]
  );
  const handleGatewaySessionsChange = useCallback(
    (keys: CollapseKey | CollapseKey[]) => updateSectionOpenState('gateway-sessions', keys),
    [updateSectionOpenState]
  );
  const peekedIds = peekedSessionIds ?? new Set<string>();
  const trimmedSearchQuery = searchQuery.trim();
  const searchActive = isSessionSearchActive(trimmedSearchQuery);

  const handleTogglePeekSession = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      onTogglePeekSession?.(sessionId);
    },
    [onTogglePeekSession]
  );

  const getCallbackRelationship = useCallback((session: Session) => {
    return (
      session.remote_surrogate?.relationship ??
      session.remote_relationships?.as_target?.find(
        (relationship: RemoteRelationshipRef) => relationship.relationship_type === 'remote_create'
      )
    );
  }, []);

  const getRemoteParentId = useCallback(
    (session: Session): string | undefined => {
      if (session.remote_surrogate) return undefined;

      const relationshipParentId = session.remote_relationships?.as_target?.find(
        (relationship: RemoteRelationshipRef) => relationship.relationship_type === 'remote_create'
      )?.source_session_id;
      if (relationshipParentId) return relationshipParentId;

      // Defensive fallback for live-patched session rows that may temporarily
      // lack enriched remote_relationships. A cross-branch callback target is
      // still local to the already-loaded Agor session store and points at the
      // same creator/remote-parent session for remote-created children.
      const callbackTargetId = session.callback_config?.callback_session_id;
      const callbackTarget = callbackTargetId
        ? sessions.find((candidate) => candidate.session_id === callbackTargetId)
        : undefined;
      if (callbackTarget && callbackTarget.branch_id !== session.branch_id) {
        return callbackTargetId;
      }

      return undefined;
    },
    [sessions]
  );

  const getCallbackTargetId = useCallback(
    (session: Session): string | undefined => {
      const relationship = getCallbackRelationship(session);
      return (
        session.callback_config?.callback_session_id ??
        relationship?.callback_session_id ??
        session.genealogy?.parent_session_id ??
        session.remote_surrogate?.source_session_id
      );
    },
    [getCallbackRelationship]
  );

  const getCallbackToggle = useCallback(
    (session: Session) => {
      const targetId = getCallbackTargetId(session);
      if (!targetId) return null;

      const relationship = getCallbackRelationship(session);
      const enabled = session.callback_config?.enabled ?? relationship?.callback_enabled ?? true;

      return {
        enabled,
        disabled: connectionDisabled || !client,
        tooltip: enabled
          ? 'Callbacks linked — click to stop callback notifications while keeping the relationship'
          : 'Callbacks unlinked — click to resume callback notifications for this relationship',
      };
    },
    [client, connectionDisabled, getCallbackRelationship, getCallbackTargetId]
  );

  const handleToggleCallback = useCallback(
    async (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!client) return;

      const session = sessions.find((candidate) => candidate.session_id === sessionId);
      if (!session) return;

      const targetId = getCallbackTargetId(session);
      if (!targetId) return;

      const toggle = getCallbackToggle(session);
      const nextEnabled = !(toggle?.enabled ?? false);

      try {
        await client.service('sessions').patch(session.session_id, {
          callback_config: {
            ...(session.callback_config ?? {}),
            callback_session_id: targetId as SessionID,
            enabled: nextEnabled,
          },
        });
        showSuccess(nextEnabled ? 'Callbacks linked' : 'Callbacks unlinked');
      } catch (error) {
        showError(
          `Failed to update callbacks: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    [client, getCallbackTargetId, getCallbackToggle, sessions, showError, showSuccess]
  );

  const handleOpenRemoteParent = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const session = sessions.find((candidate) => candidate.session_id === sessionId);
      const remoteParentId = session ? getRemoteParentId(session) : undefined;
      if (!remoteParentId) return;
      onSessionClick?.(remoteParentId);
    },
    [getRemoteParentId, onSessionClick, sessions]
  );

  const handleForkSpawnConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!forkSpawnModal.session) return;

    if (forkSpawnModal.action === 'fork') {
      const prompt = typeof config === 'string' ? config : config.prompt || '';
      await onForkSession?.(forkSpawnModal.session.session_id, prompt);
    } else {
      await onSpawnSession?.(forkSpawnModal.session.session_id, config);
    }
  };

  const closeForkSpawnModal = () => setForkSpawnModal((current) => ({ ...current, open: false }));
  const unmountForkSpawnModal = () =>
    setForkSpawnModal({ open: false, action: 'fork', session: null });

  const handleArchiveSession = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();

      modal.confirm({
        title: 'Archive session and same-branch children?',
        content:
          'This archives the session and its same-branch forked or spawned descendants. Remote-created sessions remain active.',
        okText: 'Archive',
        cancelText: 'Cancel',
        onOk: async () => {
          setArchivingSessionIds((prev) => new Set(prev).add(sessionId));
          try {
            const result = await archiveSession(sessionId as SessionID);
            if (result?.reconciliation === 'refresh-required') {
              showWarning(ARCHIVE_REFRESH_WARNING);
            } else if (result) {
              showSuccess('Session and same-branch children archived');
            } else {
              showError('Failed to archive session');
            }
          } finally {
            setArchivingSessionIds((prev) => {
              const next = new Set(prev);
              next.delete(sessionId);
              return next;
            });
          }
        },
      });
    },
    [archiveSession, modal, showSuccess, showError, showWarning]
  );

  const getGatewaySource = useCallback(
    (session: Session) => getGatewaySourceCore(session) ?? undefined,
    []
  );

  const isGatewaySession = useCallback((session: Session): boolean => {
    return isGatewaySessionCore(session);
  }, []);

  const activeSessions = useMemo(() => sessions.filter((s) => !s.archived), [sessions]);
  const gatewayRootSessions = useMemo(
    () => activeSessions.filter((s) => !s.scheduled_from_branch && isGatewaySession(s)),
    [activeSessions, isGatewaySession]
  );
  const gatewayTreeSessionIds = useMemo(() => {
    const candidates = activeSessions.filter((session) => !session.scheduled_from_branch);

    // A gateway child does not carry gateway_source itself. Follow the exact
    // genealogy edges used by buildSessionTree (including remote surrogates)
    // so descendants stay with the gateway conversation instead of being
    // promoted to unrelated roots in the manual Sessions section.
    return collectSessionSubtreeIds(
      candidates,
      gatewayRootSessions.map((session) => session.session_id)
    );
  }, [activeSessions, gatewayRootSessions]);
  const manualSessions = useMemo(
    () =>
      activeSessions.filter(
        (session) =>
          !session.scheduled_from_branch && !gatewayTreeSessionIds.has(session.session_id)
      ),
    [activeSessions, gatewayTreeSessionIds]
  );
  const scheduledSessions = useMemo(
    () =>
      activeSessions
        .filter((s) => s.scheduled_from_branch)
        .sort((a, b) => (b.scheduled_run_at || 0) - (a.scheduled_run_at || 0)),
    [activeSessions]
  );
  const gatewayTreeSessions = useMemo(
    () =>
      activeSessions.filter(
        (session) => !session.scheduled_from_branch && gatewayTreeSessionIds.has(session.session_id)
      ),
    [activeSessions, gatewayTreeSessionIds]
  );
  const searchablePanelSessions = useMemo(
    () => [...manualSessions, ...scheduledSessions, ...gatewayTreeSessions],
    [gatewayTreeSessions, manualSessions, scheduledSessions]
  );
  const sortedManualSessions = useMemo(
    () => (isManualSessionsOpen ? sortSessions(manualSessions, sort) : []),
    [isManualSessionsOpen, manualSessions, sort]
  );
  const sessionTreeData = useMemo(
    () => (isManualSessionsOpen ? buildSessionTree(sortedManualSessions) : []),
    [isManualSessionsOpen, sortedManualSessions]
  );
  const gatewaySessionTreeData = useMemo(
    () =>
      isGatewaySessionsOpen ? buildSessionTree(sortSessions(gatewayTreeSessions, 'recent')) : [],
    [gatewayTreeSessions, isGatewaySessionsOpen]
  );
  const collectExpandableKeys = useCallback((nodes: SessionTreeNode[]): React.Key[] => {
    const keys: React.Key[] = [];
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        keys.push(node.key);
        keys.push(...collectExpandableKeys(node.children));
      }
    }
    return keys;
  }, []);
  const manualExpandableKeys = useMemo(
    () => collectExpandableKeys(sessionTreeData),
    [collectExpandableKeys, sessionTreeData]
  );
  const gatewayExpandableKeys = useMemo(
    () => collectExpandableKeys(gatewaySessionTreeData),
    [collectExpandableKeys, gatewaySessionTreeData]
  );
  const searchResults = useMemo(
    () =>
      isPanel && searchActive
        ? searchSessions(searchablePanelSessions, trimmedSearchQuery).map(({ session }) => session)
        : [],
    [isPanel, searchActive, searchablePanelSessions, trimmedSearchQuery]
  );

  const hasRunningScheduledSession = useMemo(
    () => scheduledSessions.some(isSessionExecuting),
    [scheduledSessions]
  );
  const hasRunningGatewaySession = useMemo(
    () => gatewayTreeSessions.some(isSessionExecuting),
    [gatewayTreeSessions]
  );

  const isCreating = branch.filesystem_status === 'creating';
  const isFailed = branch.filesystem_status === 'failed';

  // Parent sessions default to expanded; only collapsed exceptions are kept in
  // the collapsedBranchNodes store. Deriving the expanded set means sessions
  // that newly gain children start expanded, while stored exceptions survive
  // sessions temporarily leaving the tree (archive, lost children).
  const collapsedSessionIds = collapsedNode.sessionIds;
  const collapsedSessionIdSet = useMemo(
    () => new Set(isPanel ? collapsedSessionIds : undefined),
    [collapsedSessionIds, isPanel]
  );
  const expandedManualKeys = useMemo(
    () => manualExpandableKeys.filter((key) => !collapsedSessionIds?.includes(String(key))),
    [collapsedSessionIds, manualExpandableKeys]
  );
  const expandedGatewayKeys = useMemo(
    () => gatewayExpandableKeys.filter((key) => !collapsedSessionIds?.includes(String(key))),
    [collapsedSessionIds, gatewayExpandableKeys]
  );

  const treeNodeById = useMemo(() => {
    const byId = new Map<string, SessionTreeNode>();
    const visit = (nodes: SessionTreeNode[]) => {
      for (const node of nodes) {
        byId.set(node.key, node);
        if (node.children) visit(node.children);
      }
    };
    if (animatePanel) visit([...sessionTreeData, ...gatewaySessionTreeData]);
    return byId;
  }, [animatePanel, gatewaySessionTreeData, sessionTreeData]);

  const revealRows = useCallback(
    (sessionId: string) => {
      const revealed = new Map<string, number>();
      // Descendants become visible down to the next still-collapsed parent.
      const visit = (node: SessionTreeNode | undefined) => {
        for (const child of node?.children ?? []) {
          revealed.set(child.key, revealed.size);
          if (!collapsedSessionIdSet.has(child.key)) visit(child);
        }
      };
      visit(treeNodeById.get(sessionId));
      setEnteringRows(revealed);
      clearTimeout(enteringRowsTimer.current);
      enteringRowsTimer.current = setTimeout(
        () => setEnteringRows(EMPTY_ENTERING_ROWS),
        ROW_ENTER_CLEAR_MS
      );
    },
    [collapsedSessionIdSet, treeNodeById]
  );

  const toggleSessionCollapsed = useCallback(
    (sessionId: string) => {
      if (animatePanel && collapsedSessionIdSet.has(sessionId)) revealRows(sessionId);
      updateCollapsedNode((node) => {
        const sessionIds = new Set(node.sessionIds ?? []);
        if (sessionIds.has(sessionId)) sessionIds.delete(sessionId);
        else sessionIds.add(sessionId);
        return { ...node, sessionIds: [...sessionIds] };
      });
    },
    [animatePanel, collapsedSessionIdSet, revealRows, updateCollapsedNode]
  );

  const handleSessionTreeExpand = useCallback(
    (keys: React.Key[], expandableKeys: React.Key[]) => {
      // Only reconcile keys currently in the tree so exceptions stored for
      // sessions outside this render set (archived, filtered) are preserved.
      const expandedKeySet = new Set(keys.map(String));
      updateCollapsedNode((node) => {
        const sessionIds = new Set(node.sessionIds ?? []);
        for (const key of expandableKeys) {
          const sessionId = String(key);
          if (expandedKeySet.has(sessionId)) sessionIds.delete(sessionId);
          else sessionIds.add(sessionId);
        }
        return { ...node, sessionIds: [...sessionIds] };
      });
    },
    [updateCollapsedNode]
  );

  const isPanelRowFailed = (session: Session) =>
    isSessionFailed(session) && !isSessionExecuting(session);

  const sessionRowStyle = (session: Session): React.CSSProperties => {
    const isSessionSelected = session.session_id === selectedSessionId;
    const isRemoteSurrogate = Boolean(session.remote_surrogate);
    if (isPanel) {
      // Borderless rows: status lives in the trailing dot, selection in the fill.
      return {
        border: 0,
        borderRadius: token.borderRadiusSM,
        paddingBlock: 0,
        // A tight lead-in keeps the logo close to the chevron; the trailing status mark
        // gets more room so it sits comfortably inside a selected or failed fill.
        paddingInlineStart: token.paddingXXS,
        paddingInlineEnd: token.paddingSM,
        minHeight: panelRowHeight,
        // A failed session tints its whole row so it stands out; the icon keeps it non-color-only.
        background: isPanelRowFailed(session)
          ? isSessionSelected
            ? // Hover is nearly identical to Bg in the light theme; Active reads as selected.
              token.colorErrorBgActive
            : token.colorErrorBg
          : isSessionSelected
            ? token.colorFillSecondary
            : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        width: '100%',
        boxSizing: 'border-box',
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        whiteSpace: 'normal',
        opacity: isRemoteSurrogate ? 0.78 : undefined,
      };
    }
    return {
      borderWidth: 1,
      borderStyle: isRemoteSurrogate ? 'dashed' : 'solid',
      borderColor: session.ready_for_prompt ? token.colorPrimary : token.colorBorderSecondary,
      borderRadius: 4,
      padding: 8,
      background: isRemoteSurrogate ? token.colorFillQuaternary : 'transparent',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-start',
      width: '100%',
      height: 'auto',
      boxSizing: 'border-box',
      cursor: 'pointer',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'left',
      whiteSpace: 'normal',
      marginBottom: 4,
      opacity: isRemoteSurrogate ? 0.78 : undefined,
      boxShadow: session.ready_for_prompt ? `0 0 12px ${token.colorPrimary}30` : undefined,
      ...(isSessionSelected
        ? { outline: `1px dashed ${token.colorTextBase}`, outlineOffset: -2 }
        : {}),
    };
  };

  const renderSessionTitle = (
    session: Session,
    options: {
      strong?: boolean;
      secondary?: boolean;
      query?: string;
      hug?: boolean;
      parent?: boolean;
    } = {}
  ) => {
    const titleText = getSessionDisplayTitle(session, { includeAgentFallback: true });
    // Panel rows signal failure with the status dot instead of danger-colored text.
    const failed = !isPanel && isSessionFailed(session);
    const muted = !isPanel && Boolean(options.secondary);
    // Panel: sessions already read recede one gentle step; ones that need you stay full strength.
    const read =
      isPanel &&
      !(
        isSessionExecuting(session) ||
        isSessionFailed(session) ||
        session.ready_for_prompt ||
        session.session_id === selectedSessionId
      );

    return (
      <Typography.Text
        strong={options.strong}
        type={failed ? 'danger' : muted ? 'secondary' : undefined}
        title={isPanel ? titleText : undefined}
        style={{
          fontSize: isPanel ? 13 : 12,
          // Parents anchor the tree's structure; leaves stay regular.
          fontWeight: isPanel && options.parent ? 500 : undefined,
          color: read ? token.colorTextSecondary : undefined,
          flex: options.hug ? '0 1 auto' : 1,
          minWidth: 0,
          ...(isPanel
            ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
            : getSessionTitleStyles(2)),
        }}
      >
        <HighlightMatch text={titleText} query={options.query ?? ''} />
      </Typography.Text>
    );
  };

  const renderSessionFailureIcon = (session: Session) => {
    if (isPanel || !isSessionFailed(session)) return null;

    return (
      <Tooltip title="Latest task failed">
        <ExclamationCircleOutlined
          aria-label="Latest task failed"
          style={{ color: token.colorErrorText, fontSize: 12, flex: '0 0 auto' }}
        />
      </Tooltip>
    );
  };

  const renderSessionTitleWithFailure = (
    session: Session,
    options: {
      strong?: boolean;
      secondary?: boolean;
      query?: string;
      hug?: boolean;
      parent?: boolean;
    } = {}
  ) => (
    <>
      {renderSessionFailureIcon(session)}
      {renderSessionTitle(session, options)}
    </>
  );

  // Panel rows show the agent logo on every row, as one steady brand column.
  const renderAgentIcon = (session: Session) => {
    if (isPanel) {
      return <ToolIcon tool={session.agentic_tool} size={PANEL_AGENT_ICON_SIZE} bordered={false} />;
    }
    return isSessionExecuting(session) ? (
      <Spin size="small" />
    ) : (
      <ToolIcon tool={session.agentic_tool} size={20} />
    );
  };

  const renderPanelStatusDot = (session: Session) => {
    if (!isPanel) return null;
    const running = isSessionExecuting(session);
    const failed = !running && isSessionFailed(session);
    if (!running && !failed && !session.ready_for_prompt) return null;
    if (failed) {
      // A shape, not just a color, separates failure from the ready dot.
      return (
        <ExclamationCircleOutlined
          role="img"
          aria-label="Latest task failed"
          title="Latest task failed"
          style={{ color: token.colorErrorText, fontSize: token.fontSizeSM, flex: '0 0 auto' }}
        />
      );
    }
    const label = running ? 'Running' : 'Ready for prompt';
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={running ? 'status-dot-run' : undefined}
        style={{
          display: 'inline-block',
          width: PANEL_STATUS_DOT_SIZE,
          height: PANEL_STATUS_DOT_SIZE,
          borderRadius: '50%',
          flex: '0 0 auto',
          background: running ? token.colorSuccess : token.colorPrimary,
        }}
      />
    );
  };

  // Panel section headers use the session panel's uppercase label ("Queued Tasks").
  const panelSectionLabelStyle: React.CSSProperties = {
    fontSize: token.fontSizeSM,
    fontWeight: 500,
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
  };
  const renderSectionLabel = (label: string) =>
    isPanel ? (
      <Typography.Text type="secondary" style={panelSectionLabelStyle}>
        {label}
      </Typography.Text>
    ) : (
      <Typography.Text strong>{label}</Typography.Text>
    );

  const renderSectionCount = (count: number, badgeColor: string) =>
    isPanel ? (
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {count}
      </Typography.Text>
    ) : (
      <Badge count={count} showZero style={{ backgroundColor: badgeColor }} />
    );

  const renderFlatSessionRow = (session: Session, query = '') => {
    const callbackToggle = getCallbackToggle(session);
    const remoteParentId = getRemoteParentId(session);
    const titleText = getSessionDisplayTitle(session, { includeAgentFallback: true });
    const descriptionSnippet =
      query && session.title && session.description
        ? getMatchSnippet(session.description, query)
        : null;
    const toolMatches = query ? sessionToolMatches(session, query) : false;
    const sourceLabel = session.scheduled_from_branch
      ? 'Scheduled'
      : isGatewaySession(session)
        ? 'Gateway'
        : null;

    return (
      <SessionItemWithActions
        key={session.session_id}
        sessionId={session.session_id}
        isArchiving={archivingSessionIds.has(session.session_id)}
        hoverFill={isPanel}
        deferActions={isPanel}
        onArchive={handleArchiveSession}
        callbackToggle={callbackToggle ?? undefined}
        onToggleCallback={callbackToggle ? handleToggleCallback : undefined}
        remoteParentLink={
          remoteParentId
            ? { tooltip: 'Open remote parent session that created this session' }
            : undefined
        }
        onOpenRemoteParent={remoteParentId ? handleOpenRemoteParent : undefined}
        onSettings={
          onOpenSessionSettings
            ? (id, e) => {
                e.stopPropagation();
                onOpenSessionSettings(id);
              }
            : undefined
        }
      >
        <button
          type="button"
          style={sessionRowStyle(session)}
          data-session-id={session.session_id}
          aria-label={getSessionRowAccessibleLabel(session, isPanel ? {} : undefined)}
          onClick={() => onSessionClick?.(session.session_id)}
        >
          <div
            style={{
              display: 'flex',
              alignItems: isPanel ? 'center' : 'flex-start',
              gap: isPanel ? token.marginXS : 4,
              flex: 1,
              minWidth: 0,
            }}
          >
            {renderAgentIcon(session)}
            <SessionRelationshipIcon session={session} size={10} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                {renderSessionTitleWithFailure(session, { query })}
              </div>
              {(sourceLabel || toolMatches) && (
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, display: 'block', marginTop: 2 }}
                >
                  {sourceLabel}
                  {sourceLabel && toolMatches ? ' · ' : ''}
                  {toolMatches && (
                    <>
                      Agent: <HighlightMatch text={session.agentic_tool} query={query} />
                    </>
                  )}
                </Typography.Text>
              )}
              {descriptionSnippet && descriptionSnippet !== titleText && (
                <Typography.Text
                  type="secondary"
                  style={{
                    fontSize: 11,
                    fontStyle: 'italic',
                    lineHeight: 1.4,
                    display: 'block',
                    marginTop: 2,
                  }}
                >
                  <HighlightMatch text={descriptionSnippet} query={query} />
                </Typography.Text>
              )}
            </div>
            {renderPanelStatusDot(session)}
          </div>
        </button>
      </SessionItemWithActions>
    );
  };

  // One chevron for panel section headers and tree parents: same glyph, size, color and column.
  const renderPanelChevron = useCallback(
    (expanded: boolean) => (
      <RightOutlined
        style={{
          fontSize: token.fontSizeSM,
          color: token.colorTextTertiary,
          transform: expanded ? 'rotate(90deg)' : undefined,
          transition: animatePanel
            ? `transform ${token.motionDurationMid} ${token.motionEaseInOut}`
            : undefined,
        }}
      />
    ),
    [
      animatePanel,
      token.colorTextTertiary,
      token.fontSizeSM,
      token.motionDurationMid,
      token.motionEaseInOut,
    ]
  );

  const renderTreeSwitcherIcon = useCallback(
    (nodeProps: {
      eventKey?: React.Key;
      expanded?: boolean;
      isLeaf?: boolean;
      session?: Session;
    }) => {
      const key = nodeProps.eventKey;
      if (nodeProps.isLeaf || key == null) return null;

      const expanded = Boolean(nodeProps.expanded);
      const sessionTitle = nodeProps.session
        ? getSessionDisplayTitle(nodeProps.session, { includeAgentFallback: true })
        : 'session';
      const Icon = expanded ? MinusSquareOutlined : PlusSquareOutlined;
      const label = `${expanded ? 'Collapse' : 'Expand'} ${sessionTitle}`;
      const toggle = (event: React.MouseEvent) => {
        event.stopPropagation();
        toggleSessionCollapsed(String(key));
      };

      if (isPanel) {
        // A compact AntD button owns hover and focus, centered on the row rather than Tree's first line.
        return (
          // Inline styles beat the switcher-icon class Tree adds to this clone: its
          // inline-block breaks centering, and its closed-state rotation stacks on ours.
          <Flex
            align="center"
            justify="center"
            style={{ display: 'flex', height: panelRowHeight, transform: 'none' }}
          >
            <Button
              type="text"
              size="small"
              aria-label={label}
              aria-expanded={expanded}
              icon={renderPanelChevron(expanded)}
              onClick={toggle}
            />
          </Flex>
        );
      }

      return (
        <button
          type="button"
          aria-label={label}
          aria-expanded={expanded}
          onClick={toggle}
          style={{
            border: 0,
            background: 'transparent',
            padding: 0,
            // Match Tree's first-line hover surface without inline baseline offsets.
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '1lh',
            lineHeight: 'inherit',
            cursor: 'pointer',
            color: 'inherit',
          }}
        >
          <Icon />
        </button>
      );
    },
    [isPanel, panelRowHeight, renderPanelChevron, toggleSessionCollapsed]
  );

  const renderSessionNode = (node: SessionTreeNode) => {
    const session = node.session;
    const hiddenChildCount =
      isPanel && collapsedSessionIdSet.has(session.session_id) ? (node.children?.length ?? 0) : 0;
    const isRemoteSurrogate = node.relationshipType === 'remote';
    const callbackToggle = getCallbackToggle(session);
    const remoteParentId = getRemoteParentId(session);
    const gatewaySource = getGatewaySource(session);
    const isGateway = isGatewaySession(session);

    return (
      <SessionItemWithActions
        sessionId={session.session_id}
        isArchiving={archivingSessionIds.has(session.session_id)}
        isPeeked={peekedIds.has(session.session_id)}
        deferActions={isPanel}
        onArchive={handleArchiveSession}
        onTogglePeek={onTogglePeekSession ? handleTogglePeekSession : undefined}
        callbackToggle={callbackToggle ?? undefined}
        onToggleCallback={callbackToggle ? handleToggleCallback : undefined}
        remoteParentLink={
          remoteParentId
            ? { tooltip: 'Open remote parent session that created this session' }
            : undefined
        }
        onOpenRemoteParent={remoteParentId ? handleOpenRemoteParent : undefined}
        onSettings={
          onOpenSessionSettings
            ? (id, e) => {
                e.stopPropagation();
                onOpenSessionSettings(id);
              }
            : undefined
        }
      >
        <button
          type="button"
          // Keep the same total row spacing, but center the border inside Tree's hover fill.
          style={{ ...sessionRowStyle(session), marginBlock: isPanel ? 0 : 2 }}
          data-session-id={session.session_id}
          aria-label={getSessionRowAccessibleLabel(
            session,
            isPanel ? { hiddenChildCount } : undefined
          )}
          onClick={() => onSessionClick?.(session.session_id)}
          onContextMenu={(e) => {
            if (onForkSession || onSpawnSession) {
              e.preventDefault();
            }
          }}
        >
          <Flex
            align={isGateway && !isPanel ? 'flex-start' : 'center'}
            gap={isPanel ? token.marginXS : token.marginXXS}
            flex={1}
            style={{ minWidth: 0 }}
          >
            {renderAgentIcon(session)}
            {isRemoteSurrogate ? (
              <Tooltip title="Remote session created from this session. Click to open it in its own branch.">
                <ExportOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
              </Tooltip>
            ) : isPanel && node.relationshipType === 'spawn' ? null : (
              // Panel indentation already shows a spawn; forks and btw keep their marker.
              <SessionRelationshipIcon session={session} size={10} />
            )}
            {isPanel ? (
              // One-line rows: the channel is quiet metadata beside the title, not a pill below it.
              <Flex align="center" gap={token.marginXS} flex={1} style={{ minWidth: 0 }}>
                {renderSessionTitleWithFailure(session, {
                  hug: isGateway,
                  parent: Boolean(node.children?.length),
                })}
                {isGateway && (
                  <Typography.Text
                    type="secondary"
                    title={gatewaySource?.channel_name ?? 'Gateway'}
                    style={{
                      fontSize: token.fontSizeSM,
                      flex: '0 1 auto',
                      minWidth: 0,
                      maxWidth: '45%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {gatewaySource ? (
                      <>
                        {getChannelIcon(gatewaySource.channel_type)} {gatewaySource.channel_name}
                      </>
                    ) : (
                      'Gateway'
                    )}
                  </Typography.Text>
                )}
              </Flex>
            ) : (
              <Flex vertical gap={isGateway ? token.marginXXS : 0} flex={1} style={{ minWidth: 0 }}>
                <Flex align="center" gap={token.marginXXS} style={{ minWidth: 0 }}>
                  {renderSessionTitleWithFailure(session)}
                </Flex>
                {isGateway &&
                  (gatewaySource ? (
                    <ChannelPill
                      channelType={gatewaySource.channel_type}
                      channelName={gatewaySource.channel_name}
                      style={{ alignSelf: 'flex-start' }}
                    />
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 11, fontStyle: 'italic' }}>
                      (Gateway - metadata unavailable)
                    </Typography.Text>
                  ))}
              </Flex>
            )}
            {hiddenChildCount > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {hiddenChildCount}
              </Typography.Text>
            )}
            {renderPanelStatusDot(session)}
          </Flex>
        </button>
      </SessionItemWithActions>
    );
  };

  // Everything renderSessionNode reads besides the node and its per-row flags.
  const sessionRowContext = useMemo(
    () => [
      token,
      isPanel,
      panelRowHeight,
      sessions,
      handleArchiveSession,
      handleTogglePeekSession,
      onTogglePeekSession,
      getCallbackToggle,
      handleToggleCallback,
      getRemoteParentId,
      handleOpenRemoteParent,
      onOpenSessionSettings,
      onSessionClick,
      onForkSession,
      onSpawnSession,
    ],
    [
      token,
      isPanel,
      panelRowHeight,
      sessions,
      handleArchiveSession,
      handleTogglePeekSession,
      onTogglePeekSession,
      getCallbackToggle,
      handleToggleCallback,
      getRemoteParentId,
      handleOpenRemoteParent,
      onOpenSessionSettings,
      onSessionClick,
      onForkSession,
      onSpawnSession,
    ]
  );
  const rowEnterMotion = useMemo(
    () => ({ duration: token.motionDurationMid, easing: token.motionEaseOut }),
    [token.motionDurationMid, token.motionEaseOut]
  );
  const renderMemoSessionNode = (node: SessionTreeNode) => {
    const sessionId = node.session.session_id;
    return (
      <MemoSessionTreeRow
        node={node}
        render={renderSessionNode}
        enterIndex={isPanel ? (enteringRows.get(sessionId) ?? null) : undefined}
        enterMotion={rowEnterMotion}
        rowInputs={[
          enteringRows.get(sessionId),
          sessionRowContext,
          sessionId === selectedSessionId,
          peekedIds.has(sessionId),
          archivingSessionIds.has(sessionId),
          collapsedSessionIdSet.has(sessionId),
        ]}
      />
    );
  };

  const renderSessionTree = (
    treeData: SessionTreeNode[],
    expandedKeys: React.Key[],
    expandableKeys: React.Key[],
    onContentSizeChange: (contentHeight: number, viewportHeight: number) => void
  ) => (
    <BranchSessionTree
      className={`agor-flat-tree nodrag nowheel${isPanel ? ' agor-panel-session-tree' : ''}`}
      fillAvailableHeight={fillPanel}
      onContentSizeChange={onContentSizeChange}
      treeData={treeData}
      expandedKeys={expandedKeys}
      onExpand={(keys) => handleSessionTreeExpand(keys as React.Key[], expandableKeys)}
      showLine={!isPanel}
      // Toggle instantly; Tree's height motion re-lays out the virtual list every frame.
      motion={isPanel ? false : undefined}
      switcherIcon={renderTreeSwitcherIcon}
      showIcon={false}
      blockNode
      selectable={false}
      titleRender={renderMemoSessionNode}
      // Rows carry their own hover/selection fill, so Tree's 4px node gap is just air.
      styles={isPanel ? { item: { marginBottom: 0 } } : undefined}
    />
  );

  const panelFlexStyle: React.CSSProperties | undefined = fillPanel
    ? { display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, minHeight: 0 }
    : undefined;
  // Section chevrons share the top-level tree chevron column.
  const panelSectionHeaderStyle: React.CSSProperties | undefined = isPanel
    ? { paddingInline: 0 }
    : undefined;
  // Section bodies nest one level under their header, with a guide under its chevron.
  const panelSectionBodyGuide: React.CSSProperties | undefined = isPanel
    ? {
        marginInlineStart: token.controlHeightSM / 2,
        paddingInlineStart: token.controlHeightSM / 2 - token.lineWidth,
        borderInlineStart: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
      }
    : undefined;
  // The chevron slot supplies the one standard step before the title.
  const panelSectionIconStyle: React.CSSProperties | undefined = isPanel
    ? { marginInlineEnd: 0 }
    : undefined;
  const panelExpandIcon = isPanel
    ? ({ isActive }: { isActive?: boolean }) => (
        // The inset matches row padding, so section titles share the row title column.
        <Flex
          align="center"
          justify="center"
          style={{ width: token.controlHeightSM, marginInlineEnd: token.paddingXXS }}
        >
          {renderPanelChevron(Boolean(isActive))}
        </Flex>
      )
    : undefined;
  const treeBodyStyles = {
    header: { flexShrink: 0, ...panelSectionHeaderStyle },
    icon: panelSectionIconStyle,
    body: {
      ...panelFlexStyle,
      background: 'transparent',
      paddingInline: isPanel ? 0 : undefined,
      // Panel headers already separate the list; Collapse's body inset leaves a gap.
      paddingTop: isPanel ? 0 : undefined,
      ...panelSectionBodyGuide,
    },
  };
  // Leave a few rows reachable when headers/other sections exceed a short
  // panel. The outer teammate viewport then scrolls instead of clipping them.
  const expandedPanelStyle = (maxHeight?: number): React.CSSProperties | undefined =>
    fillPanel
      ? { ...panelFlexStyle, minHeight: Math.min(140, maxHeight ?? 140), maxHeight }
      : undefined;

  const sessionListContent = isManualSessionsOpen
    ? renderSessionTree(
        sessionTreeData,
        expandedManualKeys,
        manualExpandableKeys,
        manualTreeSection.onContentSizeChange
      )
    : null;

  const sessionListHeader = (
    <Flex justify="space-between" align="center" style={{ width: '100%' }}>
      <Space size={isPanel ? token.marginXS : 4} align="center">
        {renderSectionLabel('Sessions')}
        {renderSectionCount(manualSessions.length, token.colorPrimaryBgHover)}
        {!isPanel && (
          <SessionSortButton sort={sort} onSortChange={setSort} compact stopPropagation />
        )}
      </Space>
      {onCreateSession && (
        <div className="nodrag">
          {isPanel ? (
            <Tooltip title={isCreating ? undefined : 'New session'}>
              <Button
                type="text"
                size={isMobileViewport ? 'middle' : 'small'}
                icon={<PlusOutlined />}
                aria-label="New Session"
                disabled={connectionDisabled || isCreating}
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateSession(branch.branch_id);
                }}
                title={isCreating ? 'Branch is being created...' : undefined}
                style={
                  isMobileViewport
                    ? { minWidth: MOBILE_TOUCH_TARGET, minHeight: MOBILE_TOUCH_TARGET }
                    : undefined
                }
              />
            </Tooltip>
          ) : (
            <Button
              type="default"
              size="small"
              icon={<PlusOutlined />}
              disabled={connectionDisabled || isCreating}
              onClick={(e) => {
                e.stopPropagation();
                onCreateSession(branch.branch_id);
              }}
              title={isCreating ? 'Branch is being created...' : undefined}
            >
              New Session
            </Button>
          )}
        </div>
      )}
    </Flex>
  );

  const scheduledRunsHeader = (
    <Flex justify="space-between" align="center" style={{ width: '100%' }}>
      <Space size={isPanel ? token.marginXS : 4} align="center">
        {!isPanel && <ClockCircleOutlined style={{ color: token.colorInfo }} />}
        {renderSectionLabel('Scheduled Runs')}
        {renderSectionCount(scheduledSessions.length, token.colorInfoBgHover)}
        {hasRunningScheduledSession && <Spin size="small" />}
      </Space>
    </Flex>
  );

  // Panel scheduled rows keep their paging but sit in the tree's title column,
  // after the chevron column (Tree's switcher, whose margin/padding the panel drops).
  const panelFlatRowInset = token.controlHeightSM;
  const scheduledRunsContent = isScheduledRunsOpen ? (
    <PagedSessions
      key={branch.branch_id}
      sessions={scheduledSessions}
      rowGap={isPanel ? 0 : undefined}
    >
      {(session) => {
        const callbackToggle = getCallbackToggle(session);
        const remoteParentId = getRemoteParentId(session);
        const item = (
          <SessionItemWithActions
            key={session.session_id}
            sessionId={session.session_id}
            isArchiving={archivingSessionIds.has(session.session_id)}
            isPeeked={peekedIds.has(session.session_id)}
            hoverFill={isPanel}
            deferActions={isPanel}
            onArchive={handleArchiveSession}
            onTogglePeek={onTogglePeekSession ? handleTogglePeekSession : undefined}
            callbackToggle={callbackToggle ?? undefined}
            onToggleCallback={callbackToggle ? handleToggleCallback : undefined}
            remoteParentLink={
              remoteParentId
                ? { tooltip: 'Open remote parent session that created this session' }
                : undefined
            }
            onOpenRemoteParent={remoteParentId ? handleOpenRemoteParent : undefined}
            onSettings={
              onOpenSessionSettings
                ? (id, e) => {
                    e.stopPropagation();
                    onOpenSessionSettings(id);
                  }
                : undefined
            }
          >
            <button
              type="button"
              style={sessionRowStyle(session)}
              aria-label={getSessionRowAccessibleLabel(session, isPanel ? {} : undefined)}
              onClick={() => onSessionClick?.(session.session_id)}
            >
              {isPanel ? (
                <Flex align="center" gap={token.marginXS} flex={1} style={{ minWidth: 0 }}>
                  {renderAgentIcon(session)}
                  {renderSessionTitleWithFailure(session, { secondary: true })}
                  {renderPanelStatusDot(session)}
                </Flex>
              ) : (
                <Space size={4} align="center" style={{ flex: 1, minWidth: 0 }}>
                  {renderAgentIcon(session)}
                  {renderSessionTitleWithFailure(session, { secondary: true })}
                </Space>
              )}
            </button>
          </SessionItemWithActions>
        );
        return isPanel ? (
          <div key={session.session_id} style={{ paddingInlineStart: panelFlatRowInset }}>
            {item}
          </div>
        ) : (
          item
        );
      }}
    </PagedSessions>
  ) : null;

  const gatewaySessionsHeader = (
    <Flex justify="space-between" align="center" style={{ width: '100%' }}>
      <Space size={isPanel ? token.marginXS : 4} align="center">
        {!isPanel && <MessageOutlined style={{ color: token.colorSuccess }} />}
        {renderSectionLabel('Gateway Sessions')}
        {renderSectionCount(gatewayRootSessions.length, token.colorSuccessBgHover)}
        {hasRunningGatewaySession && <Spin size="small" />}
      </Space>
    </Flex>
  );

  const gatewaySessionsContent = isGatewaySessionsOpen
    ? renderSessionTree(
        gatewaySessionTreeData,
        expandedGatewayKeys,
        gatewayExpandableKeys,
        gatewayTreeSection.onContentSizeChange
      )
    : null;

  const sessionSearchBar =
    isPanel && activeSessions.length > 0 ? (
      <div style={{ paddingBottom: 12, paddingTop: 4, flexShrink: 0 }}>
        <SessionSearchToolbar
          value={searchQuery}
          onChange={setSearchQuery}
          sort={sort}
          onSortChange={setSort}
          searching={searchActive}
        />
      </div>
    ) : null;

  if (isPanel && searchActive && searchablePanelSessions.length > 0) {
    return (
      <>
        {sessionSearchBar}
        {searchResults.length > 0 && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, padding: '2px 8px 4px', display: 'block' }}
          >
            {searchResults.length} of {searchablePanelSessions.length} · <SessionRelevanceLabel />
          </Typography.Text>
        )}
        {searchResults.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '24px 16px',
              gap: 6,
            }}
          >
            <Typography.Text strong style={{ fontSize: 13 }}>
              No results
            </Typography.Text>
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.5, maxWidth: 180 }}
            >
              Nothing matched <Typography.Text code>{trimmedSearchQuery}</Typography.Text>
            </Typography.Text>
          </div>
        ) : (
          <PagedSessions
            key={`${branch.branch_id}:${trimmedSearchQuery}`}
            sessions={searchResults}
            rowGap={isPanel ? 0 : undefined}
          >
            {(session) => renderFlatSessionRow(session, trimmedSearchQuery)}
          </PagedSessions>
        )}

        {forkSpawnModal.session && (
          <ForkSpawnModal
            open={forkSpawnModal.open}
            action={forkSpawnModal.action}
            session={forkSpawnModal.session}
            currentUser={currentUserId ? userById.get(currentUserId) : undefined}
            onConfirm={handleForkSpawnConfirm}
            onCancel={closeForkSpawnModal}
            afterClose={unmountForkSpawnModal}
            client={client}
            userById={userById}
          />
        )}
      </>
    );
  }

  return (
    // Card mode disables antd motion: 30 cards animating their collapse/tree
    // mounts multiplies board-mount commits (#1768). Panel mode keeps motion.
    <ConfigProvider theme={isPanel ? undefined : NO_MOTION_THEME}>
      {sessionSearchBar}
      {activeSessions.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            alignItems: 'center',
            padding: isPanel ? '24px 0' : '16px 0',
            marginTop: 8,
          }}
        >
          {isCreating ? (
            <Typography.Text type="secondary">Creating branch on filesystem...</Typography.Text>
          ) : isFailed ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'center' }}>
              <Typography.Text type="danger" strong>
                Branch creation failed
              </Typography.Text>
              {branch.error_message && (
                <Tooltip title={branch.error_message} placement="bottom">
                  <Typography.Text
                    type="secondary"
                    style={{
                      fontSize: 12,
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      cursor: 'help',
                    }}
                  >
                    {branch.error_message}
                  </Typography.Text>
                </Tooltip>
              )}
            </div>
          ) : onCreateSession ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={connectionDisabled}
              onClick={(e) => {
                e.stopPropagation();
                onCreateSession(branch.branch_id);
              }}
              size="middle"
            >
              Create Session
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {manualSessions.length > 0 ? (
            <Collapse
              ref={manualTreeSection.ref}
              className={
                fillPanel && isManualSessionsOpen ? 'agor-panel-session-tree-section' : undefined
              }
              activeKey={openSectionKeys}
              onChange={handleManualSessionsChange}
              items={[
                {
                  key: 'sessions',
                  label: sessionListHeader,
                  children: sessionListContent,
                  style: panelFlexStyle,
                  styles: treeBodyStyles,
                },
              ]}
              ghost
              expandIcon={panelExpandIcon}
              style={{
                marginTop: 8,
                flexShrink: 0,
                ...(isManualSessionsOpen
                  ? expandedPanelStyle(manualTreeSection.maxHeight)
                  : undefined),
              }}
            />
          ) : onCreateSession ? (
            <div style={{ marginTop: 8 }}>{sessionListHeader}</div>
          ) : null}

          {scheduledSessions.length > 0 && (
            <Collapse
              activeKey={openSectionKeys}
              onChange={handleScheduledRunsChange}
              items={[
                {
                  key: 'scheduled-runs',
                  label: scheduledRunsHeader,
                  children: scheduledRunsContent,
                  styles: {
                    header: panelSectionHeaderStyle,
                    icon: panelSectionIconStyle,
                    body: {
                      background: 'transparent',
                      paddingInline: isPanel ? 0 : undefined,
                      paddingTop: isPanel ? 0 : undefined,
                      ...panelSectionBodyGuide,
                    },
                  },
                },
              ]}
              ghost
              expandIcon={panelExpandIcon}
              style={{ marginTop: manualSessions.length > 0 ? 0 : 8, flexShrink: 0 }}
            />
          )}

          {gatewayRootSessions.length > 0 && (
            <Collapse
              ref={gatewayTreeSection.ref}
              className={
                fillPanel && isGatewaySessionsOpen ? 'agor-panel-session-tree-section' : undefined
              }
              activeKey={openSectionKeys}
              onChange={handleGatewaySessionsChange}
              items={[
                {
                  key: 'gateway-sessions',
                  label: gatewaySessionsHeader,
                  children: gatewaySessionsContent,
                  style: panelFlexStyle,
                  styles: treeBodyStyles,
                },
              ]}
              ghost
              expandIcon={panelExpandIcon}
              style={{
                marginTop: manualSessions.length > 0 || scheduledSessions.length > 0 ? 0 : 8,
                flexShrink: 0,
                ...(isGatewaySessionsOpen
                  ? expandedPanelStyle(gatewayTreeSection.maxHeight)
                  : undefined),
              }}
            />
          )}
        </>
      )}

      {forkSpawnModal.session && (
        <ForkSpawnModal
          open={forkSpawnModal.open}
          action={forkSpawnModal.action}
          session={forkSpawnModal.session}
          currentUser={currentUserId ? userById.get(currentUserId) : undefined}
          onConfirm={handleForkSpawnConfirm}
          onCancel={closeForkSpawnModal}
          afterClose={unmountForkSpawnModal}
          client={client}
          userById={userById}
        />
      )}
    </ConfigProvider>
  );
};
