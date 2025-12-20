import type { AgorClient } from '@agor/core/api';
import type { Message, Session, SpawnConfig, Worktree } from '@agor/core/types';
import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { App, Button, Divider, Space, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAppData } from '../../contexts/AppDataContext';
import { ConversationView } from '../ConversationView';
import { EnvironmentPill } from '../EnvironmentPill';
import { ForkSpawnModal } from '../ForkSpawnModal';
import { IssuePill, PullRequestPill, RepoPill } from '../Pill';
import { Tag } from '../Tag';

export interface SessionPanelContentProps {
  client: AgorClient | null;
  session: Session;
  worktree?: Worktree | null;
  currentUserId?: string;
  sessionMcpServerIds?: string[];
  footerControls: React.ReactNode;
  scrollToBottom: (() => void) | null;
  scrollToTop: (() => void) | null;
  setScrollToBottom: (fn: (() => void) | null) => void;
  setScrollToTop: (fn: (() => void) | null) => void;
  queuedMessages: Message[];
  setQueuedMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  spawnModalOpen: boolean;
  setSpawnModalOpen: (open: boolean) => void;
  onSpawnModalConfirm: (config: string | Partial<SpawnConfig>) => Promise<void>;
  inputValue: string;
  isOpen: boolean;
}

export const SessionPanelContent: React.FC<SessionPanelContentProps> = ({
  client,
  session,
  worktree = null,
  currentUserId,
  sessionMcpServerIds = [],
  footerControls,
  scrollToBottom,
  scrollToTop,
  setScrollToBottom,
  setScrollToTop,
  queuedMessages,
  setQueuedMessages,
  spawnModalOpen,
  setSpawnModalOpen,
  onSpawnModalConfirm,
  inputValue,
  isOpen,
}) => {
  const { token } = theme.useToken();
  const { message } = App.useApp();

  // Get data from context
  const { userById, repoById, mcpServerById } = useAppData();

  // Get actions from context
  const {
    onOpenWorktree,
    onStartEnvironment,
    onStopEnvironment,
    onViewLogs,
    onPermissionDecision,
  } = useAppActions();

  // Get repo from worktree
  const repo = worktree ? repoById.get(worktree.repo_id) || null : null;

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
            {/* Worktree Info */}
            {worktree && repo && (
              <RepoPill
                repoName={repo.slug}
                worktreeName={worktree.name}
                onClick={onOpenWorktree ? () => onOpenWorktree(worktree.worktree_id) : undefined}
              />
            )}
            {worktree && repo && (
              <EnvironmentPill
                repo={repo}
                worktree={worktree}
                onEdit={onOpenWorktree ? () => onOpenWorktree(worktree.worktree_id) : undefined}
                onStartEnvironment={onStartEnvironment}
                onStopEnvironment={onStopEnvironment}
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
                <Tag key={server?.mcp_server_id} color="purple" icon={<ApiOutlined />}>
                  {server?.display_name || server?.name}
                </Tag>
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
        onScrollRef={(scrollBottom, scrollTop) => {
          setScrollToBottom(() => scrollBottom);
          setScrollToTop(() => scrollTop);
        }}
        onPermissionDecision={onPermissionDecision}
        worktreeName={worktree?.name}
        scheduledFromWorktree={session.scheduled_from_worktree}
        scheduledRunAt={session.scheduled_run_at}
        isActive={isOpen}
        genealogy={session.genealogy}
      />

      {/* Queued Messages Drawer - Above Footer */}
      {queuedMessages.length > 0 && (
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
            Queued Messages ({queuedMessages.length})
          </Typography.Text>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {queuedMessages.map((msg, idx) => (
              <div
                key={msg.message_id}
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
                  {msg.content_preview || (typeof msg.content === 'string' ? msg.content : '')}
                </Typography.Text>
                <Space size={4}>
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => {
                      const textToCopy = typeof msg.content === 'string' ? msg.content : '';
                      navigator.clipboard.writeText(textToCopy);
                      message.success('Message copied to clipboard');
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
                        setQueuedMessages((prev) =>
                          prev.filter((m) => m.message_id !== msg.message_id)
                        );

                        // Delete via messages service directly
                        await client.service('messages').remove(msg.message_id);
                      } catch (error) {
                        message.error(
                          `Failed to remove queued message: ${error instanceof Error ? error.message : String(error)}`
                        );

                        // Re-fetch queue to restore accurate state
                        const response = await client
                          .service(`sessions/${session.session_id}/messages/queue`)
                          .find();
                        const data = (response as { data: Message[] }).data || [];
                        setQueuedMessages(data);
                      }
                    }}
                  />
                </Space>
              </div>
            ))}
          </Space>
        </div>
      )}

      {/* Footer Controls (passed from parent) */}
      {footerControls}

      {/* Advanced Spawn Modal */}
      <ForkSpawnModal
        open={spawnModalOpen}
        action="spawn"
        session={session}
        currentUser={currentUserId ? userById.get(currentUserId) || null : null}
        mcpServerById={mcpServerById}
        initialPrompt={inputValue}
        onConfirm={onSpawnModalConfirm}
        onCancel={() => setSpawnModalOpen(false)}
        client={client}
        userById={userById}
      />
    </>
  );
};
