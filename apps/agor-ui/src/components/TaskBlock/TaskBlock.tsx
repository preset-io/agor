/**
 * TaskBlock - Collapsible task section containing messages
 *
 * Features:
 * - Collapsed: Shows task summary with metadata
 * - Expanded: Shows all messages in the task
 * - Default: Latest task expanded, older collapsed
 * - Progressive disclosure pattern
 * - Groups 3+ sequential tool-only messages into ToolBlock
 */

import {
  type Message,
  MessageRole,
  type PermissionRequestContent,
  type PermissionScope,
  PermissionStatus,
  type Task,
  TaskStatus,
  type User,
} from '@agor/core/types';
import {
  DownOutlined,
  FileTextOutlined,
  GithubOutlined,
  RightOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Avatar, Collapse, Flex, Space, Tag, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo } from 'react';
import { useAgorClient } from '../../hooks/useAgorClient';
import { useTaskEvents } from '../../hooks/useTaskEvents';
import { AgentChain } from '../AgentChain';
import { MessageBlock } from '../MessageBlock';
import { CreatedByTag } from '../metadata/CreatedByTag';
import {
  ContextWindowPill,
  GitStatePill,
  MessageCountPill,
  ModelPill,
  TimerPill,
  TokenCountPill,
  ToolCountPill,
} from '../Pill';
import { StickyTodoRenderer } from '../StickyTodoRenderer';
import { TaskStatusIcon } from '../TaskStatusIcon';
import ToolExecutingIndicator from '../ToolExecutingIndicator';
import { ToolIcon } from '../ToolIcon';

const { Paragraph } = Typography;

/**
 * Block types for rendering
 */
type Block = { type: 'message'; message: Message } | { type: 'agent-chain'; messages: Message[] };

interface TaskBlockProps {
  task: Task;
  messages: Message[];
  agentic_tool?: string;
  sessionModel?: string;
  users?: User[];
  currentUserId?: string;
  defaultExpanded?: boolean;
  sessionId?: string | null;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
}

/**
 * Check if message contains ONLY tools/thinking/tool-results (no user-facing text)
 * Returns true if message should be in AgentChain, false if it should be a regular message bubble
 */
function isAgentChainMessage(message: Message): boolean {
  // EXCEPTION: User messages with ONLY tool_result blocks are part of agent execution
  // (tool results are technically "user" role per Anthropic API, but they're automated responses)
  if (message.role === MessageRole.USER && Array.isArray(message.content)) {
    const hasOnlyToolResults = message.content.every(block => block.type === 'tool_result');
    if (hasOnlyToolResults) return true; // Part of agent chain, don't break it
  }

  // Only assistant messages beyond this point
  if (message.role !== MessageRole.ASSISTANT) return false;

  // String content - this is user-facing response, NOT agent chain
  if (typeof message.content === 'string') {
    return !message.content.trim(); // Empty = not a response
  }

  // Empty content
  if (!message.content) return false;

  // Array content - check what types of blocks we have
  if (Array.isArray(message.content)) {
    const hasTools = message.content.some(block => block.type === 'tool_use');
    const hasThinking = message.content.some(block => block.type === 'thinking');
    const hasText = message.content.some(block => block.type === 'text');

    // If it has tools BUT ALSO has text, treat as mixed message
    // We'll split it: tools go to AgentChain, text goes to MessageBlock
    if (hasTools && hasText) {
      return false; // Let MessageBlock handle the splitting
    }

    // Only tools/thinking, no text = pure agent chain
    if (hasTools || hasThinking) return true;

    // Only text blocks = user-facing response
    return false;
  }

  return false;
}

/**
 * Group messages into blocks:
 * - Consecutive assistant messages with thoughts/tools → AgentChain
 * - User messages and assistant text responses → individual MessageBlocks
 * - Permission requests are now just messages, rendered inline naturally
 */
function groupMessagesIntoBlocks(messages: Message[]): Block[] {
  const blocks: Block[] = [];
  let agentBuffer: Message[] = [];

  for (const msg of messages) {
    if (isAgentChainMessage(msg)) {
      // Accumulate agent chain messages
      agentBuffer.push(msg);
    } else {
      // Flush agent buffer if we have any
      if (agentBuffer.length > 0) {
        blocks.push({ type: 'agent-chain', messages: agentBuffer });
        agentBuffer = [];
      }

      // Add the current message as individual block
      blocks.push({ type: 'message', message: msg });
    }
  }

  // Flush remaining buffer
  if (agentBuffer.length > 0) {
    blocks.push({ type: 'agent-chain', messages: agentBuffer });
  }

  return blocks;
}

export const TaskBlock: React.FC<TaskBlockProps> = ({
  task,
  messages,
  agentic_tool,
  sessionModel,
  users = [],
  currentUserId,
  defaultExpanded = false,
  sessionId,
  onPermissionDecision,
}) => {
  const { token } = theme.useToken();
  const { client } = useAgorClient();

  // Track real-time tool executions for this task
  const { toolsExecuting } = useTaskEvents(client, task.task_id);

  // Group messages into blocks
  const blocks = useMemo(() => groupMessagesIntoBlocks(messages), [messages]);

  // Calculate context window usage percentage for visual progress bar
  const contextWindowPercentage =
    task.context_window && task.context_window_limit
      ? (task.context_window / task.context_window_limit) * 100
      : 0;

  // Color-code based on usage: green (<50%), yellow (50-80%), red (>80%)
  const _getContextWindowColor = () => {
    if (contextWindowPercentage < 50) {
      return token.colorSuccessBg; // Light green
    }
    if (contextWindowPercentage < 80) {
      return token.colorWarningBg; // Light yellow/orange
    }
    return token.colorErrorBg; // Light red
  };

  // Task header shows when collapsed
  const taskHeader = (
    <div style={{ width: '100%' }}>
      <Space size={token.sizeUnit} align="start" style={{ width: '100%' }}>
        <div style={{ fontSize: 16, marginTop: token.sizeUnit / 4 }}>
          <TaskStatusIcon status={task.status} size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: token.sizeUnit / 2,
            }}
          >
            <Typography.Text strong>
              {typeof task.description === 'string'
                ? task.description || 'User Prompt'
                : 'User Prompt'}
            </Typography.Text>
          </div>

          {/* Task metadata */}
          <Flex wrap gap={token.sizeUnit * 1.5} style={{ marginTop: token.sizeUnit / 2 }}>
            <TimerPill
              status={task.status}
              startedAt={task.message_range?.start_timestamp || task.created_at}
              endedAt={task.message_range?.end_timestamp || task.completed_at}
              durationMs={task.duration_ms}
              tooltip="Task runtime"
            />
            {task.created_by && (
              <CreatedByTag
                createdBy={task.created_by}
                currentUserId={currentUserId}
                users={users}
                prefix="By"
              />
            )}
            <MessageCountPill count={messages.length} />
            <ToolCountPill count={task.tool_use_count} />
            {task.usage?.total_tokens && (
              <TokenCountPill
                count={task.usage.total_tokens}
                estimatedCost={task.usage.estimated_cost_usd}
                inputTokens={task.usage.input_tokens}
                outputTokens={task.usage.output_tokens}
                cacheReadTokens={task.usage.cache_read_tokens}
                cacheCreationTokens={task.usage.cache_creation_tokens}
              />
            )}
            {task.context_window && task.context_window_limit && (
              <ContextWindowPill used={task.context_window} limit={task.context_window_limit} />
            )}
            {task.model && task.model !== sessionModel && <ModelPill model={task.model} />}
            {task.git_state.sha_at_start && task.git_state.sha_at_start !== 'unknown' && (
              <GitStatePill
                branch={task.git_state.ref_at_start}
                sha={task.git_state.sha_at_start}
                style={{ fontSize: 11 }}
              />
            )}
            {task.report && (
              <Tag icon={<FileTextOutlined />} color="green" style={{ fontSize: 11 }}>
                Report
              </Tag>
            )}
          </Flex>
        </div>
      </Space>
    </div>
  );

  return (
    <Collapse
      defaultActiveKey={defaultExpanded ? ['task-content'] : []}
      expandIcon={({ isActive }) => (isActive ? <DownOutlined /> : <RightOutlined />)}
      style={{ background: 'transparent', border: 'none', margin: `${token.sizeUnit}px 0` }}
      items={[
        {
          key: 'task-content',
          label: taskHeader,
          style: { border: 'none' },
          styles: {
            header: {
              padding: `${token.sizeUnit}px ${token.sizeUnit * 1.5}px`,
              background: token.colorBgContainer,
              border: `1px solid ${token.colorBorder}`,
              borderRadius: token.borderRadius * 1.5,
              alignItems: 'flex-start',
            },
            body: {
              border: 'none',
              background: 'transparent',
              padding: `${token.sizeUnit}px ${token.sizeUnit * 1.5}px`,
            },
          },
          children: (
            <div style={{ paddingTop: token.sizeUnit }}>
              {/* Render all blocks (messages and agent chains) */}
              {blocks.map((block, blockIndex) => {
                if (block.type === 'message') {
                  // Find if this is a permission request and if it's the first pending one
                  const isPermissionRequest = block.message.type === 'permission_request';
                  let isFirstPending = false;

                  if (isPermissionRequest) {
                    const content = block.message.content as PermissionRequestContent;
                    if (content.status === PermissionStatus.PENDING) {
                      // Check if this is the first pending permission request
                      isFirstPending = !blocks.slice(0, blockIndex).some(b => {
                        if (b.type === 'message' && b.message.type === 'permission_request') {
                          const c = b.message.content as PermissionRequestContent;
                          return c.status === PermissionStatus.PENDING;
                        }
                        return false;
                      });
                    }
                  }

                  return (
                    <MessageBlock
                      key={block.message.message_id}
                      message={block.message}
                      agentic_tool={agentic_tool}
                      users={users}
                      currentUserId={task.created_by}
                      isTaskRunning={task.status === TaskStatus.RUNNING}
                      sessionId={sessionId}
                      onPermissionDecision={onPermissionDecision}
                      isFirstPendingPermission={isFirstPending}
                      taskId={task.task_id}
                    />
                  );
                }
                if (block.type === 'agent-chain') {
                  // Use first message ID as key for agent chain
                  const blockKey = `agent-chain-${block.messages[0]?.message_id || 'unknown'}`;
                  return <AgentChain key={blockKey} messages={block.messages} />;
                }
                return null;
              })}

              {/* Show tool execution indicators when tools are running */}
              {toolsExecuting.length > 0 && (
                <div style={{ margin: `${token.sizeUnit * 1.5}px 0` }}>
                  <ToolExecutingIndicator toolsExecuting={toolsExecuting} />
                </div>
              )}

              {/* Show sticky TODO (latest) above typing indicator when task is running */}
              {task.status === TaskStatus.RUNNING && <StickyTodoRenderer messages={messages} />}

              {/* Show typing indicator whenever task is actively running */}
              {task.status === TaskStatus.RUNNING && (
                <div style={{ margin: `${token.sizeUnit}px 0` }}>
                  <Bubble
                    placement="start"
                    avatar={
                      agentic_tool ? (
                        <ToolIcon tool={agentic_tool} size={32} />
                      ) : (
                        <Avatar
                          icon={<RobotOutlined />}
                          style={{ backgroundColor: token.colorSuccess }}
                        />
                      )
                    }
                    loading={true}
                    content=""
                    variant="outlined"
                  />
                </div>
              )}

              {/* Show commit message if available */}
              {task.git_state.commit_message && (
                <div
                  style={{
                    marginTop: token.sizeUnit * 1.5,
                    padding: `${token.sizeUnit * 0.75}px ${token.sizeUnit * 1.25}px`,
                    background: 'rgba(0, 0, 0, 0.02)',
                    borderRadius: token.borderRadius,
                  }}
                >
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <GithubOutlined /> Commit:{' '}
                  </Typography.Text>
                  <Typography.Text code style={{ fontSize: 11 }}>
                    {typeof task.git_state.commit_message === 'string'
                      ? task.git_state.commit_message
                      : JSON.stringify(task.git_state.commit_message)}
                  </Typography.Text>
                </div>
              )}

              {/* Show report if available */}
              {task.report && (
                <div style={{ marginTop: token.sizeUnit * 1.5 }}>
                  <Tag icon={<FileTextOutlined />} color="green">
                    Task Report
                  </Tag>
                  <Paragraph
                    style={{
                      marginTop: token.sizeUnit,
                      padding: token.sizeUnit * 1.5,
                      background: 'rgba(82, 196, 26, 0.05)',
                      border: `1px solid ${token.colorSuccessBorder}`,
                      borderRadius: token.borderRadius,
                      fontSize: 13,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {typeof task.report === 'string'
                      ? task.report
                      : JSON.stringify(task.report, null, 2)}
                  </Paragraph>
                </div>
              )}
            </div>
          ),
        },
      ]}
    />
  );
};
