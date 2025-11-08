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

import type { AgorClient } from '@agor/core/api';
import {
  type Message,
  MessageRole,
  type PermissionRequestContent,
  type PermissionScope,
  PermissionStatus,
  type SessionID,
  type Task,
  TaskStatus,
  type User,
} from '@agor/core/types';
import {
  DownOutlined,
  FileTextOutlined,
  GithubOutlined,
  RobotOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Collapse, Flex, Space, Spin, Tag, Typography, theme } from 'antd';
import React, { useMemo } from 'react';
import { useStreamingMessages } from '../../hooks/useStreamingMessages';
import { useTaskEvents } from '../../hooks/useTaskEvents';
import { useTaskMessages } from '../../hooks/useTaskMessages';
import { getContextWindowGradient } from '../../utils/contextWindow';
import { AgentChain } from '../AgentChain';
import { AgorAvatar } from '../AgorAvatar';
import { MessageBlock } from '../MessageBlock';
import { CreatedByTag } from '../metadata/CreatedByTag';
import {
  ContextWindowPill,
  GitStatePill,
  MessageCountPill,
  ModelPill,
  ScheduledRunPill,
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
  client: AgorClient | null;
  agentic_tool?: string;
  sessionModel?: string;
  users?: User[];
  currentUserId?: string;
  isExpanded: boolean;
  onExpandChange: (expanded: boolean) => void;
  sessionId?: SessionID | null;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
  scheduledFromWorktree?: boolean;
  scheduledRunAt?: number;
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

    // SPECIAL: Task tools should display as regular agent messages, not in chain
    const hasOnlyTaskTool =
      message.content.length === 1 &&
      message.content[0].type === 'tool_use' &&
      (message.content[0] as { name?: string }).name === 'Task';

    if (hasOnlyTaskTool) {
      return false; // Show as regular message bubble
    }

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
 * - Task tool nested operations → AgentChain (grouped by parent_tool_use_id)
 * - Permission requests are now just messages, rendered inline naturally
 */
function groupMessagesIntoBlocks(messages: Message[]): Block[] {
  // Separate top-level messages from nested (parent_tool_use_id)
  const topLevel = messages.filter(m => !m.parent_tool_use_id);
  const nested = messages.filter(m => m.parent_tool_use_id);

  // Collect all Task tool use IDs for special handling
  const taskToolIds = new Set<string>();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && (block as { name?: string }).name === 'Task') {
          taskToolIds.add((block as { id?: string }).id || '');
        }
      }
    }
  }

  // Group nested messages by parent tool use ID
  const nestedByParent = new Map<string, Message[]>();
  for (const msg of nested) {
    if (!msg.parent_tool_use_id) continue;
    if (!nestedByParent.has(msg.parent_tool_use_id)) {
      nestedByParent.set(msg.parent_tool_use_id, []);
    }
    nestedByParent.get(msg.parent_tool_use_id)!.push(msg);
  }

  // Build map of tool_use_id -> tool_result message for Task tools
  const taskResultsByToolId = new Map<string, Message>();
  for (const msg of topLevel) {
    if (msg.role === MessageRole.USER && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
          if (toolUseId && taskToolIds.has(toolUseId)) {
            taskResultsByToolId.set(toolUseId, msg);
          }
        }
      }
    }
  }

  const blocks: Block[] = [];
  let agentBuffer: Message[] = [];

  for (const msg of topLevel) {
    // Check if this is a Task tool result (user message with tool_result for a Task tool)
    const isTaskResult =
      msg.role === MessageRole.USER &&
      Array.isArray(msg.content) &&
      msg.content.some(
        block =>
          block.type === 'tool_result' &&
          taskToolIds.has((block as { tool_use_id?: string }).tool_use_id || '')
      );

    // Skip Task results - they'll be included with their nested operations below
    if (isTaskResult) {
      continue;
    }

    // Regular message handling
    if (!isAgentChainMessage(msg)) {
      // Flush agent buffer if we have any
      if (agentBuffer.length > 0) {
        blocks.push({ type: 'agent-chain', messages: agentBuffer });
        agentBuffer = [];
      }

      // Add the current message as individual block
      blocks.push({ type: 'message', message: msg });
    } else {
      // Accumulate agent chain messages
      agentBuffer.push(msg);
    }

    // After processing the message, check if it has Task tool uses
    // If so, add nested operations + result as a regular agent-chain
    const taskTools = msg.tool_uses?.filter(t => t.name === 'Task') || [];
    for (const taskTool of taskTools) {
      const children = nestedByParent.get(taskTool.id) || [];
      const resultMsg = taskResultsByToolId.get(taskTool.id);

      // Combine nested operations with result message
      const chainMessages = [...children];
      if (resultMsg) {
        chainMessages.push(resultMsg);
      }

      if (chainMessages.length > 0) {
        // Flush agent buffer before nested operations
        if (agentBuffer.length > 0) {
          blocks.push({ type: 'agent-chain', messages: agentBuffer });
          agentBuffer = [];
        }

        // Show nested operations + result as a regular agent chain
        blocks.push({ type: 'agent-chain', messages: chainMessages });
      }
    }
  }

  // Flush remaining buffer
  if (agentBuffer.length > 0) {
    blocks.push({ type: 'agent-chain', messages: agentBuffer });
  }

  return blocks;
}

export const TaskBlock = React.memo<TaskBlockProps>(
  ({
    task,
    client,
    agentic_tool,
    sessionModel,
    users = [],
    currentUserId,
    isExpanded,
    onExpandChange,
    sessionId,
    onPermissionDecision,
    scheduledFromWorktree,
    scheduledRunAt,
  }) => {
    const { token } = theme.useToken();

    // Track real-time tool executions for this task
    const { toolsExecuting } = useTaskEvents(client, task.task_id);

    // Fetch messages for this task (only when expanded)
    const { messages: taskMessages, loading: messagesLoading } = useTaskMessages(
      client,
      task.task_id,
      isExpanded
    );

    // Track real-time streaming messages (for running tasks)
    const streamingMessages = useStreamingMessages(client, sessionId ?? undefined);

    // Merge task messages with streaming messages (for running tasks)
    const messages = useMemo(() => {
      // Filter streaming messages for this task
      const streamingForTask = Array.from(streamingMessages.values()).filter(
        msg => msg.task_id === task.task_id
      );

      // Filter out DB messages that are already in streaming (avoid duplicates)
      const dbOnlyMessages = taskMessages.filter(msg => !streamingMessages.has(msg.message_id));

      // Combine and sort by index
      return ([...dbOnlyMessages, ...streamingForTask] as Message[]).sort(
        (a, b) => a.index - b.index
      );
    }, [taskMessages, streamingMessages, task.task_id]);

    // Group messages into blocks
    const blocks = useMemo(() => groupMessagesIntoBlocks(messages), [messages]);

    // Calculate message count from task message_range
    const messageCount = task.message_range.end_index - task.message_range.start_index + 1;

    // Calculate tool count (hybrid approach)
    // - For completed tasks: use stored count (no messages needed)
    // - For running tasks: calculate from loaded messages (live count)
    const toolCount =
      task.status === TaskStatus.COMPLETED
        ? task.tool_use_count
        : messages.reduce((sum, msg) => sum + (msg.tool_uses?.length || 0), 0);

    // Calculate gradient for task header background
    const taskHeaderGradient = getContextWindowGradient(
      task.context_window,
      task.context_window_limit
    );

    // Task header shows when collapsed
    const taskHeader = (
      <Flex gap={token.sizeUnit * 2} style={{ width: '100%' }}>
        {/* Left column: Icons stacked vertically */}
        <Flex
          vertical
          align="center"
          gap={token.sizeUnit / 2}
          style={{ width: 'auto', paddingTop: token.sizeUnit }}
        >
          {isExpanded ? (
            <UpOutlined style={{ color: token.colorPrimary }} />
          ) : (
            <DownOutlined style={{ color: token.colorPrimary }} />
          )}
          <TaskStatusIcon status={task.status} size={16} />
        </Flex>

        {/* Right column: Content */}
        <Flex vertical flex={1} style={{ minWidth: 0 }}>
          <Flex
            align="center"
            wrap
            gap={token.sizeUnit / 2}
            style={{ marginBottom: token.sizeUnit }}
          >
            <Typography.Text>
              {typeof task.description === 'string'
                ? task.description || 'User Prompt'
                : 'User Prompt'}
            </Typography.Text>
          </Flex>

          {/* Task metadata */}
          <Flex wrap gap={token.sizeUnit * 1.5}>
            <TimerPill
              status={task.status}
              startedAt={task.message_range?.start_timestamp || task.created_at}
              endedAt={task.message_range?.end_timestamp || task.completed_at}
              durationMs={task.duration_ms}
              tooltip="Task runtime"
            />
            {scheduledFromWorktree && scheduledRunAt && (
              <ScheduledRunPill scheduledRunAt={scheduledRunAt} />
            )}
            {task.created_by && (
              <CreatedByTag
                createdBy={task.created_by}
                currentUserId={currentUserId}
                users={users}
                prefix="By"
              />
            )}
            <MessageCountPill count={messageCount} />
            <ToolCountPill count={toolCount} />
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
              <ContextWindowPill
                used={task.usage?.input_tokens || task.context_window}
                limit={task.context_window_limit}
                taskMetadata={{
                  usage: task.usage,
                  model: task.model,
                  model_usage: task.model_usage,
                  duration_ms: task.duration_ms,
                }}
              />
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
        </Flex>
      </Flex>
    );

    return (
      <Collapse
        activeKey={isExpanded ? ['task-content'] : []}
        onChange={keys => onExpandChange(keys.length > 0)}
        expandIcon={() => null}
        style={{ background: 'transparent', border: 'none', margin: `${token.sizeUnit}px 0` }}
        items={[
          {
            key: 'task-content',
            label: taskHeader,
            style: { border: 'none' },
            styles: {
              header: {
                padding: token.sizeUnit * 2,
                background: taskHeaderGradient || token.colorBgContainer,
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
                {/* Show loading spinner while fetching messages */}
                {messagesLoading && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'center',
                      padding: `${token.sizeUnit * 2}px 0`,
                    }}
                  >
                    <Spin size="small" />
                  </div>
                )}

                {/* Render all blocks (messages and agent chains) */}
                {!messagesLoading &&
                  blocks.map((block, blockIndex) => {
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

                      // Check if this is the latest agent message (last message block)
                      const isLatestMessage =
                        block.message.role === MessageRole.ASSISTANT &&
                        blockIndex === blocks.length - 1;

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
                          isLatestMessage={isLatestMessage}
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
                          <AgorAvatar
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
  }
);

TaskBlock.displayName = 'TaskBlock';
