import type { AgorClient, Branch, Session, SpawnConfig, Task } from '@agor-live/client';
import { getTeammateConfig, isTeammate, sessionPath } from '@agor-live/client';
import {
  CopyOutlined,
  DeleteOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { Alert, Button, Divider, Space, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById, selectRepoById, selectUserById } from '../../store/selectors';
import { copyToClipboard } from '../../utils/clipboard';
import { useThemedMessage } from '../../utils/message';
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
  setQueuedTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  spawnModalOpen: boolean;
  setSpawnModalOpen: (open: boolean) => void;
  onSpawnModalConfirm: (config: string | Partial<SpawnConfig>) => Promise<void>;
  inputValueRef: React.RefObject<string>;
  isOpen: boolean;
  /** When true, all task blocks are force-expanded (used by in-session search) */
  forceExpandAll?: boolean;
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
    setQueuedTasks,
    spawnModalOpen,
    setSpawnModalOpen,
    onSpawnModalConfirm,
    inputValueRef,
    isOpen,
    forceExpandAll = false,
  }) => {
    const { token } = theme.useToken();
    const { showSuccess, showError } = useThemedMessage();
    const [resumeQueueInFlight, setResumeQueueInFlight] = React.useState(false);
    const isQueueHeldByFailure = queuedTasks.length > 0 && session.status === 'failed';

    const handleResumeHeldQueue = React.useCallback(async () => {
      if (!client || resumeQueueInFlight) return;
      setResumeQueueInFlight(true);
      try {
        await client.service('sessions').patch(session.session_id, { ready_for_prompt: true });
        showSuccess('Resuming queued prompts');
      } catch (error) {
        showError(
          `Failed to resume queue: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setResumeQueueInFlight(false);
      }
    }, [client, resumeQueueInFlight, session.session_id, showError, showSuccess]);

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
                  truncateToFit
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
                icon={<VerticalAlignTopOutlined />}
                onClick={() => scrollToTop?.()}
                disabled={!scrollToTop}
              />
            </Tooltip>
            <Tooltip title="Scroll to bottom of conversation">
              <Button
                type="text"
                size="small"
                icon={<VerticalAlignBottomOutlined />}
                onClick={() => scrollToBottom?.()}
                disabled={!scrollToBottom}
              />
            </Tooltip>
          </Space>
        </div>

        <Divider style={{ margin: `${token.sizeUnit * 2}px 0` }} />

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
          forceExpandAll={forceExpandAll}
          onOpenAgenticToolSettings={onOpenAgenticToolSettings}
        />

        {/* Queued Tasks Drawer - Above Footer.
            Reads tasks (status='queued') instead of messages now that the queue
            is task-centric (see never-lose-prompt §C). The full prompt lives on
            task.full_prompt; description is the truncated 120-char preview. */}
        {queuedTasks.length > 0 && (
          <div
            style={{
              flexShrink: 0,
              background: token.colorBgElevated,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              borderTopLeftRadius: token.borderRadiusLG,
              borderTopRightRadius: token.borderRadiusLG,
              padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px`,
              marginLeft: -token.sizeUnit * 6 + token.sizeUnit * 2,
              marginRight: -token.sizeUnit * 6 + token.sizeUnit * 2,
              marginTop: token.sizeUnit * 2,
              boxShadow: `0 -2px 8px ${token.colorBgMask}`,
            }}
          >
            <Typography.Text
              type="secondary"
              style={{
                fontSize: token.fontSizeSM,
                display: 'block',
                marginBottom: token.sizeUnit * 2,
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              Queued Tasks ({queuedTasks.length})
            </Typography.Text>
            {isQueueHeldByFailure && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: token.sizeUnit * 2 }}
                message="Queue paused by failed session"
                description="Queued prompts are preserved. Resume the queue to run the next prompt without copy/paste."
                action={
                  <Button
                    size="small"
                    type="primary"
                    loading={resumeQueueInFlight}
                    disabled={!client}
                    onClick={handleResumeHeldQueue}
                  >
                    Resume queue
                  </Button>
                }
              />
            )}
            <Space orientation="vertical" size={8} style={{ width: '100%' }}>
              {queuedTasks.map((task, idx) => (
                <div
                  key={task.task_id}
                  style={{
                    background: token.colorBgContainer,
                    padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 3}px`,
                    borderRadius: token.borderRadius,
                    border: `1px solid ${token.colorBorder}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: token.sizeUnit * 2,
                  }}
                >
                  <Typography.Text ellipsis style={{ flex: 1 }}>
                    <span style={{ color: token.colorTextSecondary, marginRight: token.sizeUnit }}>
                      {idx + 1}.
                    </span>
                    {task.full_prompt}
                  </Typography.Text>
                  <Space size={4}>
                    {isQueueHeldByFailure && idx === 0 && (
                      <Button
                        size="small"
                        type="link"
                        loading={resumeQueueInFlight}
                        disabled={!client}
                        onClick={handleResumeHeldQueue}
                      >
                        Run next
                      </Button>
                    )}
                    <Button
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={async () => {
                        await copyToClipboard(task.full_prompt);
                        showSuccess('Message copied to clipboard');
                      }}
                    />
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={async () => {
                        if (!client) return;

                        try {
                          // Optimistically remove from UI
                          setQueuedTasks((prev) => prev.filter((t) => t.task_id !== task.task_id));

                          // Delete the queued task — cascade removes the row
                          // entirely; spawnTaskExecutor never gets a chance.
                          await client.service('tasks').remove(task.task_id);
                        } catch (error) {
                          showError(
                            `Failed to remove queued task: ${error instanceof Error ? error.message : String(error)}`
                          );

                          // Re-fetch queue to restore accurate state
                          const response = await client
                            .service(`sessions/${session.session_id}/tasks/queue`)
                            .find();
                          const data = (response as { data: Task[] }).data || [];
                          setQueuedTasks(data);
                        }
                      }}
                    />
                  </Space>
                </div>
              ))}
            </Space>
          </div>
        )}

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
