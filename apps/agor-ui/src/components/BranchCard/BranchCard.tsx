import type { AgorClient, Branch, Repo, Session, SpawnConfig, User } from '@agor-live/client';
import { getTeammateConfig, isSessionExecuting, isTeammate } from '@agor-live/client';
import {
  BranchesOutlined,
  CodeOutlined,
  DragOutlined,
  EditOutlined,
  PushpinFilled,
  RobotOutlined,
} from '@ant-design/icons';
import { Button, Card, Space, Spin, Tooltip, Typography, theme } from 'antd';
import { AggregationColor } from 'antd/es/color-picker/color';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useProgressiveMount } from '../../hooks/useProgressiveMount';
import {
  REACT_FLOW_DRAG_HANDLE_CLASS,
  REACT_FLOW_NO_DRAG_CLASS,
} from '../../utils/reactFlowDragClasses';
import { ensureColorVisible, isDarkTheme } from '../../utils/theme';
import { ArchiveActionButton } from '../ArchiveButton';
import { ArchiveDeleteBranchModal } from '../ArchiveDeleteBranchModal';
import { EnvironmentPill } from '../EnvironmentPill';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { CreatedByTag } from '../metadata';
import { IssuePill, PullRequestPill } from '../Pill';
import { BranchSessionPeekSection } from './BranchSessionPeekSection';
import { BranchSessionSections } from './BranchSessionSections';
import { estimateBranchSessionSectionsHeight } from './branchCardLayout';

const _BRANCH_CARD_MAX_WIDTH = 600;
const NOTES_MAX_LENGTH = 200; // Character limit for truncated notes
const PEEK_SESSIONS_STORAGE_KEY_PREFIX = 'agor:branch-card:peeked-session-ids:';

interface BranchCardProps {
  branch: Branch;
  repo: Repo;
  sessions: Session[]; // Sessions for this specific branch
  userById: Map<string, User>;
  currentUserId?: string;
  selectedSessionId?: string | null; // Currently open session in drawer
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (branchId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onArchiveOrDelete?: (
    branchId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onOpenSettings?: (branchId: string) => void;
  onOpenSessionSettings?: (sessionId: string) => void;
  onOpenTerminal?: (commands: string[], branchId?: string) => void;
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  onViewLogs?: (branchId: string) => void;
  onNukeEnvironment?: (branchId: string) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
  onUnpin?: (branchId: string) => void;
  isPinned?: boolean;
  zoneName?: string;
  zoneColor?: string;
  defaultExpanded?: boolean;
  inPopover?: boolean; // NEW: Enable popover-optimized mode (hides board-specific controls)
  panelMode?: boolean; // Render inside side panel instead of as a draggable canvas card
  progressiveMountKey?: string | number | null;
  /** True when this branch is the deep-link target of the current URL
   *  (`/w/<branchShort>/`). Folded together with `isFocused` (a session
   *  is open in the drawer) into a unified "selected" state — rendered
   *  as a dashed outline in `colorTextBase`, distinct from the white
   *  attention halo (returned / awaiting prompt). */
  isActiveUrlTarget?: boolean;
  client: AgorClient | null;
}

const BranchCardComponent = ({
  branch,
  repo,
  sessions,
  userById,
  currentUserId,
  selectedSessionId,
  onSessionClick,
  onCreateSession,
  onForkSession,
  onSpawnSession,
  onArchiveOrDelete,
  onOpenSettings,
  onOpenSessionSettings,
  onOpenTerminal,
  onStartEnvironment,
  onStopEnvironment,
  onViewLogs,
  onNukeEnvironment,
  onUnpin,
  isPinned = false,
  zoneName,
  zoneColor,
  defaultExpanded = true,
  inPopover = false,
  panelMode = false,
  progressiveMountKey,
  isActiveUrlTarget = false,
  client,
}: BranchCardProps) => {
  const { token } = theme.useToken();
  const connectionDisabled = useConnectionDisabled();

  const branchBoardId = (branch as { board_id?: string | null }).board_id;

  // Canvas cards hydrate their session sections in chunks after the board
  // shell commits (#1768); panel/popover surfaces render a single card, so
  // they mount immediately.
  const sectionsReady = useProgressiveMount({
    enabled: !inPopover && !panelMode,
    priority: isActiveUrlTarget || sessions.some((s) => s.session_id === selectedSessionId) ? 2 : 0,
    resetKey: progressiveMountKey ?? branchBoardId ?? 'unassigned',
  });
  const sessionShellMinHeight = useMemo(
    () => estimateBranchSessionSectionsHeight(sessions, { defaultExpanded }),
    [defaultExpanded, sessions]
  );

  // Archive/Delete modal state
  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);

  // Notes expansion state
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [storedPeekedSessionIds, setStoredPeekedSessionIds] = useLocalStorage<string[]>(
    `${PEEK_SESSIONS_STORAGE_KEY_PREFIX}${branch.branch_id}`,
    []
  );

  const peekableSessions = useMemo(
    () => sessions.filter((session) => !session.archived),
    [sessions]
  );
  const peekableSessionById = useMemo(
    () =>
      new Map<string, Session>(peekableSessions.map((session) => [session.session_id, session])),
    [peekableSessions]
  );

  const peekedSessionIds = useMemo(() => {
    if (inPopover || panelMode) return [];

    const resolvedIds: string[] = [];
    const seen = new Set<string>();

    for (const rawToken of storedPeekedSessionIds) {
      const token = rawToken.trim();
      if (!token) continue;

      const session = peekableSessions.find((candidate) => candidate.session_id === token);
      if (session && !seen.has(session.session_id)) {
        resolvedIds.push(session.session_id);
        seen.add(session.session_id);
      }
    }

    return resolvedIds;
  }, [inPopover, panelMode, peekableSessions, storedPeekedSessionIds]);

  const peekedSessionIdSet = useMemo(() => new Set(peekedSessionIds), [peekedSessionIds]);
  const peekedSessions = useMemo(
    () =>
      peekedSessionIds
        .map((sessionId) => peekableSessionById.get(sessionId))
        .filter((session): session is Session => !!session),
    [peekableSessionById, peekedSessionIds]
  );

  const updatePeekedSessionIds = useCallback(
    (nextSessionIds: string[]) => setStoredPeekedSessionIds(nextSessionIds),
    [setStoredPeekedSessionIds]
  );

  useEffect(() => {
    if (inPopover || panelMode) return;
    if (storedPeekedSessionIds.join('|') === peekedSessionIds.join('|')) return;
    setStoredPeekedSessionIds(peekedSessionIds);
  }, [inPopover, panelMode, peekedSessionIds, setStoredPeekedSessionIds, storedPeekedSessionIds]);

  const handleTogglePeekSession = useCallback(
    (sessionId: string) => {
      const next = peekedSessionIdSet.has(sessionId)
        ? peekedSessionIds.filter((peekedSessionId) => peekedSessionId !== sessionId)
        : [...peekedSessionIds, sessionId];
      updatePeekedSessionIds(next);
    },
    [peekedSessionIdSet, peekedSessionIds, updatePeekedSessionIds]
  );

  // Filter out archived sessions from board card display
  const activeSessions = peekableSessions;

  // Check if any active (non-archived) session is running or stopping
  const hasRunningSession = useMemo(
    () => activeSessions.some(isSessionExecuting),
    [activeSessions]
  );

  // Check if branch is still being created on filesystem
  const isCreating = branch.filesystem_status === 'creating';
  const isFailed = branch.filesystem_status === 'failed';

  // Check if this branch is a persisted agent
  const teammateConfig = useMemo(() => getTeammateConfig(branch), [branch]);
  const isAgent = isTeammate(branch);

  // True when one of this branch's sessions is the currently opened
  // conversation. Drives the "focused" highlight on the canvas card and
  // also suppresses the louder ready-for-prompt/needs-attention glow —
  // there's no point screaming for attention at the branch you're
  // already looking at.
  const isFocused = useMemo(
    () => activeSessions.some((s) => s.session_id === selectedSessionId),
    [activeSessions, selectedSessionId]
  );

  // Check if branch needs attention (newly created OR has ready sessions)
  // Don't highlight if a session from this branch is currently open in the drawer
  const needsAttention = useMemo(() => {
    const hasReadySession = activeSessions.some((s) => s.ready_for_prompt === true);
    const shouldHighlight = (branch.needs_attention || hasReadySession) && !isFocused;

    return shouldHighlight;
  }, [activeSessions, branch.needs_attention, isFocused]);

  const isDarkMode = isDarkTheme(token);
  // AntD exposes `colorPrimaryBg` as the subtle primary surface token.
  // In dark mode it can still read a bit bright on a large card, so mix it
  // with the base background while staying in the primary token family.
  const runningCardBackgroundColor = isDarkMode
    ? `color-mix(in srgb, ${token.colorPrimaryBg} 67%, ${token.colorBgBase})`
    : token.colorPrimaryBg;
  const cardBackgroundColor = hasRunningSession
    ? runningCardBackgroundColor
    : isAgent
      ? token.colorInfoBg
      : undefined;

  // Memoize glow shadow string to avoid recomputing color normalization on every render
  const attentionGlowShadow = useMemo(() => {
    const rawGlowColor = token.colorTextBase || (isDarkMode ? '#ffffff' : '#000000');

    let glowColor: string;
    try {
      const color = new AggregationColor(rawGlowColor);
      glowColor = color.toHexString();
    } catch {
      glowColor = isDarkMode ? '#ffffff' : '#000000';
    }

    // 2-layer glow: tight solid ring + soft halo (reduced from 4 layers for less paint work)
    return `0 0 0 3px ${glowColor}, 0 0 24px 6px ${glowColor}99`;
  }, [token.colorTextBase, isDarkMode]);

  // "Selected" state — branch is either focused (one of its sessions is
  // open in the drawer) or it's the deep-link target of the current URL.
  // The two are deliberately unified: from the user's perspective both
  // answer "what am I looking at right now?". Rendered as a dashed
  // outline in `colorTextBase` so it reads as neutral against any zone /
  // teammate accent and works in both dark and light modes. Dashed
  // because (per design discussion) it visually screams "selection"
  // without leaning on a colored ring that would compete with the white
  // attention halo. Dash length is the browser default — CSS doesn't
  // expose a knob to customize it on `outline` / `border-style: dashed`,
  // and going to SVG / `border-image` for true custom dashes is more
  // complexity than this visual warrants.
  const isSelected = isFocused || isActiveUrlTarget;
  const selectedOutline = `2px dashed ${token.colorTextBase}`;

  // Ensure pin color is visible (adjust lightness if too pale)
  const visiblePinColor = useMemo(() => {
    if (!zoneColor) return undefined;
    return ensureColorVisible(zoneColor, isDarkMode, 50, 50);
  }, [zoneColor, isDarkMode]);

  // Determine if notes should show "See more" button
  const notesNeedTruncation = branch.notes && branch.notes.length > NOTES_MAX_LENGTH;
  const displayedNotes = useMemo(() => {
    if (!branch.notes) return '';
    if (!notesNeedTruncation || notesExpanded) return branch.notes;
    // Truncate at word boundary for cleaner display
    const truncated = branch.notes.slice(0, NOTES_MAX_LENGTH);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > NOTES_MAX_LENGTH * 0.8
      ? `${truncated.slice(0, lastSpace)}...`
      : `${truncated}...`;
  }, [branch.notes, notesNeedTruncation, notesExpanded]);

  // Compose card chrome from independent visual channels so multiple
  // states can stack cleanly:
  //   • `boxShadow` — attention halo for needs_attention / awaiting prompt
  //   • `outline`   — dashed selected state (focused OR active URL target)
  //   • `borderLeft` — thick accent stripe for teammate branches
  //   • `borderColor` — zone color when pinned (no other states use it)
  // outline + box-shadow are paint-only, so they don't disturb layout
  // and don't fight with each other or with `borderLeft`.
  const highlightStyle: React.CSSProperties = (() => {
    if (inPopover) return {};
    const style: React.CSSProperties = {};
    if (needsAttention) style.boxShadow = attentionGlowShadow;
    if (isSelected) {
      style.outline = selectedOutline;
      // Pull the outline fully inside the card edge so it reads as a
      // selection *inside* the card chrome rather than a separate ring
      // outside.
      style.outlineOffset = -3;
    }
    if (isPinned && zoneColor) {
      style.borderColor = zoneColor;
      style.borderWidth = 1;
    }
    if (isAgent) {
      // Teammate accent stripe: thick left border in `colorInfo`. Drops
      // the previous full `colorInfo` border (which collided with the
      // primary-color selected ring in the default theme where
      // colorInfo === colorPrimary). The stripe lives only on the left
      // edge so it doesn't compete with the dashed selected outline,
      // and composes with the zone-color border on the other three
      // edges when a teammate is also pinned.
      style.borderLeft = `4px solid ${token.colorInfo}`;
    }
    return style;
  })();

  return (
    <Card
      style={{
        width: panelMode ? '100%' : peekedSessions.length > 0 ? 880 : 500,
        cursor: 'default', // Override React Flow's drag cursor - only drag handles should show grab cursor
        transition:
          'background-color 0.2s ease-in-out, box-shadow 0.6s ease-in-out, outline 0.2s ease-in-out, border 0.6s ease-in-out, opacity 0.2s ease-in-out',
        willChange: needsAttention && !inPopover ? 'box-shadow' : 'auto',
        ...highlightStyle,
        ...(cardBackgroundColor ? { backgroundColor: cardBackgroundColor } : {}),
        // Disconnected chokepoint: block all in-card interactions (clicking
        // into a session, env pill actions, modals) and dim to communicate
        // the state. Canvas pan/zoom and the slim app-shell banner remain
        // active. See docs/disconnected-state-design.md.
        ...(connectionDisabled && !inPopover
          ? { pointerEvents: 'none' as const, opacity: 0.55 }
          : {}),
      }}
      styles={{
        body: { padding: 16 },
      }}
    >
      {/* Branch header */}
      <div
        className={!inPopover && !panelMode ? REACT_FLOW_DRAG_HANDLE_CLASS : undefined}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
          gap: 8,
          cursor: !inPopover && !panelMode ? 'grab' : undefined,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0,
          }}
        >
          {!inPopover && (
            <div
              className={REACT_FLOW_DRAG_HANDLE_CLASS}
              style={{
                display: 'flex',
                alignItems: 'center',
                cursor: panelMode ? 'default' : 'grab',
                width: 32,
                height: 32,
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {isCreating || hasRunningSession ? (
                <Spin size="large" />
              ) : isAgent && teammateConfig?.emoji ? (
                <span style={{ fontSize: 32 }}>{teammateConfig.emoji}</span>
              ) : isAgent ? (
                <RobotOutlined
                  style={{
                    fontSize: 32,
                    color: isFailed ? token.colorError : token.colorInfo,
                  }}
                />
              ) : (
                <BranchesOutlined
                  style={{
                    fontSize: 32,
                    color: isFailed ? token.colorError : token.colorPrimary,
                  }}
                />
              )}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            {isAgent ? (
              // Teammates are identified by their persona, not their git
              // location — render the agent name in the prominent slot
              // and drop the repo/branch subtitle. Repo + branch are still
              // available in the branch settings modal for power users.
              <Typography.Title
                level={4}
                style={{ margin: 0, fontWeight: 600 }}
                ellipsis={{ tooltip: teammateConfig?.displayName ?? branch.name }}
              >
                {teammateConfig?.displayName ?? branch.name}
              </Typography.Title>
            ) : (
              <>
                <Typography.Text strong ellipsis={{ tooltip: branch.name }}>
                  {branch.name}
                </Typography.Text>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12 }}
                  ellipsis={{ tooltip: repo.slug }}
                >
                  {repo.slug}
                </Typography.Text>
              </>
            )}
          </div>
        </div>

        <Space size={4} style={{ flexShrink: 0 }}>
          {!inPopover && !panelMode && isPinned && (
            <Tooltip
              title={
                zoneName
                  ? `Pinned to [${zoneName}] zone (click to unpin)`
                  : 'Pinned (click to unpin)'
              }
            >
              <Button
                type="text"
                size="small"
                icon={<PushpinFilled style={{ color: visiblePinColor }} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onUnpin?.(branch.branch_id);
                }}
                className={REACT_FLOW_NO_DRAG_CLASS}
              />
            </Tooltip>
          )}
          {!inPopover && !panelMode && (
            <Button
              type="text"
              icon={<DragOutlined style={{ fontSize: 16 }} />}
              className={REACT_FLOW_DRAG_HANDLE_CLASS}
              title="Drag to reposition"
              style={{ cursor: 'grab', padding: '4px 8px' }}
            />
          )}
          <div className={REACT_FLOW_NO_DRAG_CLASS}>
            {onOpenTerminal && (
              <Button
                type="text"
                size="small"
                icon={<CodeOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenTerminal([], branch.branch_id);
                }}
                title="Open terminal in branch directory"
              />
            )}
            {/*
              The per-branch execute-now button was tied to the old
              one-schedule-per-branch model. Branches can now hold
              multiple schedules; the run-now affordance moves into
              the schedules list rendered inside the Schedules tab.
              Removing this here in checkpoint 3; the Schedules UI
              lands in checkpoint 5.
            */}
            {onOpenSettings && (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSettings(branch.branch_id);
                }}
                title="Edit branch"
              />
            )}
            {!inPopover && !panelMode && onArchiveOrDelete && (
              <ArchiveActionButton
                tooltip="Archive or delete branch"
                disabled={connectionDisabled}
                onClick={() => setArchiveDeleteModalOpen(true)}
              />
            )}
          </div>
        </Space>
      </div>

      {/* Branch metadata - all pills on one row with wrapping */}
      <div className={REACT_FLOW_NO_DRAG_CLASS} style={{ marginBottom: 8 }}>
        <Space size={4} wrap>
          {branch.created_by && (
            <CreatedByTag
              createdBy={branch.created_by}
              currentUserId={currentUserId}
              userById={userById}
              prefix="Created by"
            />
          )}
          {branch.issue_url && <IssuePill issueUrl={branch.issue_url} currentRepo={repo} />}
          {branch.pull_request_url && (
            <PullRequestPill prUrl={branch.pull_request_url} currentRepo={repo} />
          )}
          <EnvironmentPill
            repo={repo}
            branch={branch}
            onEdit={() => onOpenSettings?.(branch.branch_id)}
            onStartEnvironment={onStartEnvironment}
            onStopEnvironment={onStopEnvironment}
            onViewLogs={onViewLogs}
            onNukeEnvironment={onNukeEnvironment}
            connectionDisabled={connectionDisabled}
            showNukeEnvironment={false}
          />
        </Space>
      </div>

      {/* Notes */}
      {branch.notes && (
        <div className={REACT_FLOW_NO_DRAG_CLASS} style={{ marginBottom: 8 }}>
          <div
            className="markdown-compact"
            style={{
              maxHeight: notesExpanded ? 'none' : '120px',
              overflow: 'hidden',
              transition: 'max-height 0.3s ease',
            }}
          >
            <MarkdownRenderer
              content={displayedNotes}
              style={{ fontSize: 12, color: token.colorTextSecondary, lineHeight: '1.5' }}
              compact={false}
              showControls={false}
            />
          </div>
          {notesNeedTruncation && (
            <Button
              type="link"
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                setNotesExpanded(!notesExpanded);
              }}
              style={{
                padding: 0,
                height: 'auto',
                fontSize: 12,
                color: token.colorLink,
              }}
            >
              {notesExpanded ? 'See less' : 'See more'}
            </Button>
          )}
        </div>
      )}

      {/* Sessions & Scheduled Runs - composable content shared with the teammate panel */}
      <div
        className={REACT_FLOW_NO_DRAG_CLASS}
        style={sectionsReady ? undefined : { minHeight: sessionShellMinHeight }}
      >
        {sectionsReady ? (
          <BranchSessionSections
            branch={branch}
            sessions={sessions}
            userById={userById}
            currentUserId={currentUserId}
            selectedSessionId={selectedSessionId}
            onSessionClick={onSessionClick}
            onCreateSession={onCreateSession}
            onForkSession={onForkSession}
            onSpawnSession={onSpawnSession}
            onOpenSessionSettings={onOpenSessionSettings}
            peekedSessionIds={peekedSessionIdSet}
            onTogglePeekSession={!inPopover && !panelMode ? handleTogglePeekSession : undefined}
            defaultExpanded={defaultExpanded}
            mode="card"
            client={client}
          />
        ) : (
          // Truthful shell while this card waits for its hydration slot: real
          // session count from data already in props, no fake placeholders.
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, display: 'block', padding: '4px 0' }}
          >
            Sessions ({peekableSessions.length})
          </Typography.Text>
        )}
      </div>

      {!inPopover && !panelMode && peekedSessions.length > 0 && (
        <BranchSessionPeekSection
          client={client}
          sessions={peekedSessions}
          userById={userById}
          currentUserId={currentUserId}
          branchName={branch.name}
          onCloseSession={handleTogglePeekSession}
        />
      )}

      {/* Archive/Delete Modal */}
      <ArchiveDeleteBranchModal
        open={archiveDeleteModalOpen}
        branch={branch}
        sessionCount={sessions.length}
        environmentRunning={branch.environment_instance?.status === 'running'}
        onConfirm={(options) => {
          onArchiveOrDelete?.(branch.branch_id, options);
          setArchiveDeleteModalOpen(false);
        }}
        onCancel={() => setArchiveDeleteModalOpen(false)}
      />
    </Card>
  );
};

// Memoize BranchCard to prevent unnecessary re-renders when parent updates
// Only re-render when branch, repo, sessions, or callback props actually change
const BranchCard = React.memo(BranchCardComponent);

export default BranchCard;
