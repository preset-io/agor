import type { AgorClient, Branch, Session, SpawnConfig, Task } from '@agor-live/client';
import { getAssistantConfig, isAssistant, sessionPath, shortId } from '@agor-live/client';
import {
  CodeOutlined,
  CommentOutlined,
  CopyOutlined,
  DeleteOutlined,
  ReloadOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { Alert, Button, Divider, Space, Tabs, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById, selectRepoById, selectUserById } from '../../store/selectors';
import { copyToClipboard } from '../../utils/clipboard';
import { useThemedMessage } from '../../utils/message';
import { BranchHeaderPill } from '../BranchHeaderPill';
import { ConversationView } from '../ConversationView';
import { EmbeddedTerminal } from '../EmbeddedTerminal/EmbeddedTerminalLazy';
import { ForkSpawnModal } from '../ForkSpawnModal';
import { IssuePill, PullRequestPill } from '../Pill';

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
  /** Claude Code CLI view toggle. Ignored for non-CLI tools. */
  cliViewMode?: 'terminal' | 'conversation';
  /** Setter for the view toggle. When provided, this component renders the
   *  Tabs bar inline above the panel; when omitted, the parent is
   *  expected to render the bar itself (legacy header-level placement). */
  setCliViewMode?: (mode: 'terminal' | 'conversation') => void;
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
    cliViewMode = 'terminal',
    setCliViewMode,
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
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: token.sizeUnit * 2,
          }}
        >
          {/* Pills section (only shown if there's content) */}
          {branch && (
            <Space size={8} wrap style={{ flex: 1 }}>
              {/* Unified Branch Pill */}
              {branch && repo && (
                <BranchHeaderPill
                  repo={repo}
                  branch={branch}
                  onOpenBranch={onOpenBranch}
                  onStartEnvironment={onStartEnvironment}
                  onStopEnvironment={onStopEnvironment}
                  onNukeEnvironment={onNukeEnvironment}
                  onViewLogs={onViewLogs}
                  identityLink={sessionPath(session.session_id)}
                />
              )}
              {/* Issue and PR Pills */}
              {branch?.issue_url && (
                <IssuePill issueUrl={branch.issue_url} currentRepo={repo ?? undefined} />
              )}
              {branch?.pull_request_url && (
                <PullRequestPill prUrl={branch.pull_request_url} currentRepo={repo ?? undefined} />
              )}
            </Space>
          )}
          {/* Spacer if no pills */}
          {!branch && <div style={{ flex: 1 }} />}
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

        {/* CLI session: proper Tabs bar (CLI terminal / Agor conversation)
            sits directly above the panel it switches, with a Restart
            affordance pinned to the right when the terminal view is
            active. Tabs are controlled — the actual content is rendered
            below as siblings (both views always mounted; see fix note
            above the ConversationView wrapper). */}
        {session.agentic_tool === 'claude-code-cli' && setCliViewMode ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: token.sizeUnit * 2,
              marginTop: token.sizeUnit * 2,
            }}
          >
            <Tabs
              activeKey={cliViewMode}
              onChange={(k) => setCliViewMode(k as 'terminal' | 'conversation')}
              size="small"
              style={{ flex: 1, marginBottom: -1 }}
              items={[
                {
                  key: 'terminal',
                  label: (
                    <span>
                      <CodeOutlined style={{ marginRight: 6 }} />
                      CLI terminal
                    </span>
                  ),
                },
                {
                  key: 'conversation',
                  label: (
                    <span>
                      <CommentOutlined style={{ marginRight: 6 }} />
                      Agor conversation
                    </span>
                  ),
                },
              ]}
            />
            {cliViewMode === 'terminal' && client && (
              <Tooltip title="Restart claude REPL in this tab (closes the Zellij tab and re-spawns claude — JSONL transcript preserved, watcher resumes from offset)">
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={async () => {
                    try {
                      await client.service(`sessions/${session.session_id}/restart-cli`).create({});
                      showSuccess('Restarting claude…');
                    } catch (err) {
                      showError(
                        `Failed to restart: ${err instanceof Error ? err.message : String(err)}`
                      );
                    }
                  }}
                  style={{ marginBottom: token.sizeUnit }}
                >
                  Restart
                </Button>
              </Tooltip>
            )}
          </div>
        ) : (
          <Divider style={{ margin: `${token.sizeUnit * 2}px 0` }} />
        )}

        {/* Claude Code CLI: embedded live `claude` REPL.
            Mounted exactly once across both view modes — we don't unmount/
            remount when the user switches to Conversation and back, because
            tearing down xterm + the Zellij channel loses scrollback. Hide
            via `display:none` instead. */}
        {session.agentic_tool === 'claude-code-cli' && (
          <div
            style={{
              display: cliViewMode === 'terminal' ? 'flex' : 'none',
              flex: 1,
              minHeight: 0,
              flexDirection: 'column',
            }}
          >
            <EmbeddedTerminal
              client={client}
              userId={currentUserId}
              branchId={session.branch_id}
              focusTabName={`cli-${shortId(session.session_id)}`}
              // Server-side ensure-create — if the cli tab doesn't yet
              // exist (cold-start race where `onCliSessionCreated`'s
              // dispatch landed in an empty room), terminals.create
              // builds the safe spawn argv from the session row and
              // creates it. Idempotent: already-running tabs no-op
              // into focus.
              ensureCliSessionId={session.session_id}
              fill
              visible={cliViewMode === 'terminal'}
            />
          </div>
        )}

        {/* Conversation View — the structured message feed rebuilt from
            the JSONL by the daemon watcher.
            We keep ConversationView mounted in both view modes (hiding via
            display:none rather than unmount/remount) for two reasons:
              1. Toggling the view should NOT lose scrollback / queued task
                 subscriptions / Feathers `messages` listeners.
              2. Repeatedly tearing down + recreating a deep React subtree
                 in a session pane appears to interact badly with React
                 Flow's pane on the left of the board (whole left column
                 loses Ant Design theming for a frame on remount). Keeping
                 both subtrees stable side-steps that. */}
        <div
          style={{
            // `contents` lets ConversationView's own flex/sizing flow as
            // if this wrapper weren't here when visible. `none` fully
            // hides without unmounting.
            display:
              session.agentic_tool === 'claude-code-cli' && cliViewMode === 'terminal'
                ? 'none'
                : 'contents',
          }}
        >
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
            // Keep ConversationView fully active even when the CLI session
            // is showing the terminal tab — otherwise the JSONL watcher's
            // `messages.create` events land on a non-subscribing pane and
            // the user has to switch tabs + scroll to trigger a refetch.
            // The wrapper above hides the visual via display:none; data
            // listeners stay live underneath.
            isActive={isOpen}
            genealogy={session.genealogy}
            assistantEmoji={
              branch && isAssistant(branch) ? getAssistantConfig(branch)?.emoji : undefined
            }
          />
        </div>

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
