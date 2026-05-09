import type { AgorClient, Session, SpawnConfig, Task, Worktree } from '@agor-live/client';
import { getAssistantConfig, isAssistant } from '@agor-live/client';
import {
  CopyOutlined,
  DeleteOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { Button, Divider, Space, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAppEntityData } from '../../contexts/AppDataContext';
import { copyToClipboard } from '../../utils/clipboard';
import { mcpServerNeedsAuth } from '../../utils/mcpAuth';
import { useThemedMessage } from '../../utils/message';
import { ConversationView } from '../ConversationView';
import { ForkSpawnModal } from '../ForkSpawnModal';
import { MCPServerPill } from '../MCPServer';
import { IssuePill, PullRequestPill } from '../Pill';
import { WorktreeHeaderPill } from '../WorktreeHeaderPill';

export interface SessionPanelContentProps {
  client: AgorClient | null;
  session: Session;
  worktree?: Worktree | null;
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
}

export const SessionPanelContent = React.memo<SessionPanelContentProps>(
  ({
    client,
    session,
    worktree = null,
    currentUserId,
    sessionMcpServerIds = [],
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
  }) => {
    const { token } = theme.useToken();
    const { showSuccess, showError } = useThemedMessage();

    // Get data from entity context only — keeps this panel insulated from
    // session/worktree/board patches flowing through AppLiveDataContext.
    const { userById, repoById, mcpServerById, userAuthenticatedMcpServerIds } = useAppEntityData();

    // Get actions from context
    const {
      onOpenWorktree,
      onStartEnvironment,
      onStopEnvironment,
      onNukeEnvironment,
      onViewLogs,
      onPermissionDecision,
      onInputResponse,
    } = useAppActions();

    // Get repo from worktree
    const repo = worktree ? repoById.get(worktree.repo_id) || null : null;

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
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: token.sizeUnit * 2,
          }}
        >
          {/* Pills section (only shown if there's content) */}
          {(worktree || sessionMcpServerIds.length > 0) && (
            <Space size={8} wrap style={{ flex: 1 }}>
              {/* Unified Worktree Pill */}
              {worktree && repo && (
                <WorktreeHeaderPill
                  repo={repo}
                  worktree={worktree}
                  onOpenWorktree={onOpenWorktree}
                  onStartEnvironment={onStartEnvironment}
                  onStopEnvironment={onStopEnvironment}
                  onNukeEnvironment={onNukeEnvironment}
                  onViewLogs={onViewLogs}
                />
              )}
              {/* Issue and PR Pills */}
              {worktree?.issue_url && <IssuePill issueUrl={worktree.issue_url} />}
              {worktree?.pull_request_url && <PullRequestPill prUrl={worktree.pull_request_url} />}
              {/* MCP Servers */}
              {sessionMcpServerIds
                .map((serverId) => mcpServerById.get(serverId))
                .filter(Boolean)
                .map((server) => (
                  <MCPServerPill
                    key={server!.mcp_server_id}
                    server={server!}
                    needsAuth={mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)}
                    client={client}
                  />
                ))}
            </Space>
          )}
          {/* Spacer if no pills */}
          {!(worktree || sessionMcpServerIds.length > 0) && <div style={{ flex: 1 }} />}
          {/* Scroll Navigation Buttons - always visible */}
          <Space size={4}>
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

        {/* Task-Centric Conversation View - Scrollable */}
        <ConversationView
          client={client}
          sessionId={session.session_id}
          agentic_tool={session.agentic_tool}
          sessionModel={session.model_config?.model}
          userById={userById}
          currentUserId={currentUserId}
          onScrollRef={handleScrollRef}
          onPermissionDecision={onPermissionDecision}
          onInputResponse={onInputResponse}
          worktreeName={worktree?.name}
          scheduledFromWorktree={session.scheduled_from_worktree}
          scheduledRunAt={session.scheduled_run_at}
          isActive={isOpen}
          genealogy={session.genealogy}
          assistantEmoji={
            worktree && isAssistant(worktree) ? getAssistantConfig(worktree)?.emoji : undefined
          }
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
