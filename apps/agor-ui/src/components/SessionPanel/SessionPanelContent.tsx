import type { AgorClient, Branch, Session, SpawnConfig, Task } from '@agor-live/client';
import { getTeammateConfig, isTeammate, sessionPath } from '@agor-live/client';
import { VerticalAlignBottomOutlined, VerticalAlignTopOutlined } from '@ant-design/icons';
import { Button, Divider, Space, Tooltip, theme } from 'antd';
import React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById, selectRepoById, selectUserById } from '../../store/selectors';
import { canSessionStartTurn } from '../../utils/sessionTurn';
import { BranchHeaderPill } from '../BranchHeaderPill';
import { BranchMetadataRow } from '../BranchMetadataRow';
import { ConversationView } from '../ConversationView';
import { ForkSpawnModal } from '../ForkSpawnModal';

export interface SessionPanelContentProps {
  client: AgorClient | null;
  session: Session;
  branch?: Branch | null;
  currentUserId?: string;
  sessionMcpServerIds?: string[];
  scrollToBottom: (() => void) | null;
  scrollToTop: (() => void) | null;
  setScrollToBottom: (fn: (() => void) | null) => void;
  setScrollToTop: (fn: (() => void) | null) => void;
  queuedTasks: Task[];
  spawnModalOpen: boolean;
  setSpawnModalOpen: (open: boolean) => void;
  onSpawnModalConfirm: (config: string | Partial<SpawnConfig>) => Promise<void>;
  inputValueRef: React.RefObject<string>;
  isOpen: boolean;
  /** When true, all task blocks are force-expanded (used by in-session search) */
}

export const SessionPanelContent = React.memo<SessionPanelContentProps>(
  ({
    client,
    session,
    branch = null,
    currentUserId,
    scrollToBottom,
    scrollToTop,
    setScrollToBottom,
    setScrollToTop,
    queuedTasks,
    spawnModalOpen,
    setSpawnModalOpen,
    onSpawnModalConfirm,
    inputValueRef,
    isOpen,
  }) => {
    const { token } = theme.useToken();
    const isMobileShell = useIsMobileViewport();
    // Subscribe only to the entity families this panel needs via narrow store
    // selectors. This keeps the panel insulated from session/branch/board
    // patches and avoids unrelated entity churn (e.g. repo edits invalidating
    // user/MCP consumers): each whole-map selector is a stable module-level
    // reference, so a slice only re-renders this content when its own reference
    // changes.
    const userById = useAgorStore(selectUserById);
    const repoById = useAgorStore(selectRepoById);
    const mcpServerById = useAgorStore(selectMcpServerById);
    // Get actions from context
    const {
      onOpenBranch,
      onStartEnvironment,
      onStopEnvironment,
      onNukeEnvironment,
      onViewLogs,
      onPermissionDecision,
      onOpenAgenticToolSettings,
    } = useAppActions();

    // Get repo from branch
    const repo = branch ? repoById.get(branch.repo_id) || null : null;

    // Stable callback for ConversationView's onScrollRef to prevent breaking React.memo
    const handleScrollRef = React.useCallback(
      (scrollBottom: () => void, scrollTop: () => void) => {
        setScrollToBottom(() => scrollBottom);
        setScrollToTop(() => scrollTop);
      },
      [setScrollToBottom, setScrollToTop]
    );

    return (
      <>
        {/* Header row with pills and scroll navigation */}
        <div
          style={{
            flexShrink: 0,
            marginBottom: token.sizeUnit,
            display: 'flex',
            // Keep navigation aligned with the branch pill's first row when metadata wraps below it.
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: token.sizeUnit * 2,
          }}
        >
          {/* Pills section (only shown if there's content) */}
          {branch && (
            <BranchMetadataRow branch={branch} repo={repo} style={{ flex: '1 1 0', minWidth: 0 }}>
              {repo && (
                <BranchHeaderPill
                  repo={repo}
                  branch={branch}
                  onOpenBranch={onOpenBranch}
                  onStartEnvironment={onStartEnvironment}
                  onStopEnvironment={onStopEnvironment}
                  onNukeEnvironment={onNukeEnvironment}
                  onViewLogs={onViewLogs}
                  identityLink={sessionPath(session.session_id)}
                  // Full labels on mobile (wrap) instead of cramped truncation.
                  truncateToFit={!isMobileShell}
                />
              )}
            </BranchMetadataRow>
          )}
          {/* Spacer if no pills */}
          {!branch && <div style={{ flex: 1 }} />}
          {/* Scroll Navigation Buttons - always visible */}
          <Space size={4} style={{ flexShrink: 0 }}>
            <Tooltip title="Scroll to top of conversation">
              <Button
                type="text"
                size="small"
                aria-label="Scroll to top of conversation"
                icon={<VerticalAlignTopOutlined />}
                onClick={() => scrollToTop?.()}
                disabled={!scrollToTop}
              />
            </Tooltip>
            <Tooltip title="Scroll to bottom of conversation">
              <Button
                type="text"
                size="small"
                aria-label="Scroll to bottom of conversation"
                icon={<VerticalAlignBottomOutlined />}
                onClick={() => scrollToBottom?.()}
                disabled={!scrollToBottom}
              />
            </Tooltip>
          </Space>
        </div>

        <Divider style={{ margin: `${token.sizeUnit * 2}px 0` }} />

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ConversationView
            client={client}
            sessionId={session.session_id}
            agentic_tool={session.agentic_tool}
            sessionModel={session.model_config?.model}
            userById={userById}
            currentUserId={currentUserId}
            onScrollRef={handleScrollRef}
            onPermissionDecision={onPermissionDecision}
            branchName={branch?.name}
            scheduledFromBranch={session.scheduled_from_branch}
            scheduledRunAt={session.scheduled_run_at}
            isActive={isOpen}
            genealogy={session.genealogy}
            teammateEmoji={
              branch && isTeammate(branch) ? getTeammateConfig(branch)?.emoji : undefined
            }
            onOpenAgenticToolSettings={onOpenAgenticToolSettings}
            canStartTurn={canSessionStartTurn(session, queuedTasks.length)}
          />
        </div>

        {/* Advanced Spawn Modal */}
        <ForkSpawnModal
          open={spawnModalOpen}
          action="spawn"
          session={session}
          currentUser={currentUserId ? userById.get(currentUserId) || null : null}
          mcpServerById={mcpServerById}
          initialPrompt={inputValueRef.current ?? ''}
          onConfirm={onSpawnModalConfirm}
          onCancel={() => setSpawnModalOpen(false)}
          client={client}
          userById={userById}
        />
      </>
    );
  }
);
