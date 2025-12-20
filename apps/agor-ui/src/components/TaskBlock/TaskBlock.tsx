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
  type MessageID,
  MessageRole,
  type PermissionRequestContent,
  type PermissionScope,
  PermissionStatus,
  type SessionID,
  type Task,
  TaskStatus,
  type User,
} from '@agor/core/types';
// TODO: Move normalization to DB or daemon API
// import { normalizeRawSdkResponse } from '@agor/core/utils/sdk-normalizer';
import {
  DownOutlined,
  FileTextOutlined,
  GithubOutlined,
  RobotOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Collapse, Flex, Spin, Typography, theme } from 'antd';
import React, { useMemo } from 'react';
import type { StreamingMessage } from '../../hooks/useStreamingMessages';
import { useTaskEvents } from '../../hooks/useTaskEvents';
import { useTaskMessages } from '../../hooks/useTaskMessages';
import { getContextWindowGradient } from '../../utils/contextWindow';
import { AgentChain } from '../AgentChain';
import { AgorAvatar } from '../AgorAvatar';
import { CompactionBlock } from '../CompactionBlock';
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
import { Tag } from '../Tag';
import { TaskStatusIcon } from '../TaskStatusIcon';
import ToolExecutingIndicator from '../ToolExecutingIndicator';
import { ToolIcon } from '../ToolIcon';

const { Paragraph } = Typography;

/**
 * Block types for rendering
 */
type Block =
  | { type: 'message'; message: Message }
  | { type: 'agent-chain'; messages: Message[] }
  | { type: 'compaction'; messages: Message[] }; // System messages (start + optional complete)

interface TaskBlockProps {
  task: Task;
  client: AgorClient | null;
  agentic_tool?: string;
  sessionModel?: string;
  userById?: Map<string, User>;
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
  worktreeName?: string;
  scheduledFromWorktree?: boolean;
  scheduledRunAt?: number;
  streamingMessages?: Map<MessageID, StreamingMessage>;
}

/**
 * Check if message contains ONLY tools/thinking/tool-results (no user-facing text)
 * Returns true if message should be in AgentChain, false if it should be a regular message bubble
 */
function isAgentChainMessage(message: Message): boolean {
  // EXCEPTION: User messages with ONLY tool_result blocks are part of agent execution
  // (tool results are technically "user" role per Anthropic API, but they're automated responses)
  if (message.role === MessageRole.USER && Array.isArray(message.content)) {
    const hasOnlyToolResults = message.content.every((block) => block.type === 'tool_result');
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
    const hasTools = message.content.some((block) => block.type === 'tool_use');
    const hasThinking = message.content.some((block) => block.type === 'thinking');
    const hasText = message.content.some((block) => block.type === 'text');

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
 * - Compaction events (system_status + system_complete) → Compaction block
 * - Permission requests are now just messages, rendered inline naturally
 */
function groupMessagesIntoBlocks(messages: Message[]): Block[] {
  // Separate top-level messages from nested (parent_tool_use_id)
  const topLevel = messages.filter((m) => !m.parent_tool_use_id);
  const nested = messages.filter((m) => m.parent_tool_use_id);

  // Build compaction event map: task_id -> [start_message, complete_message?]
  // We aggregate compaction events that share the same task_id
  const compactionEventsByTask = new Map<string, Message[]>();
  for (const msg of topLevel) {
    if (msg.role === MessageRole.SYSTEM && Array.isArray(msg.content)) {
      const hasCompactionStatus = msg.content.some(
        (b) =>
          (b.type === 'system_status' && 'status' in b && b.status === 'compacting') ||
          (b.type === 'system_complete' && 'systemType' in b && b.systemType === 'compaction')
      );
      if (hasCompactionStatus && msg.task_id) {
        if (!compactionEventsByTask.has(msg.task_id)) {
          compactionEventsByTask.set(msg.task_id, []);
        }
        compactionEventsByTask.get(msg.task_id)!.push(msg);
      }
    }
  }

  // Get set of message IDs that are part of compaction blocks (to skip in main loop)
  const compactionMessageIds = new Set<string>();
  for (const compactionMessages of compactionEventsByTask.values()) {
    for (const msg of compactionMessages) {
      compactionMessageIds.add(msg.message_id);
    }
  }

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
    // Skip compaction messages - they'll be added as aggregated blocks later
    if (compactionMessageIds.has(msg.message_id)) {
      continue;
    }

    // Check if this is a Task tool result (user message with tool_result for a Task tool)
    const isTaskResult =
      msg.role === MessageRole.USER &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (block) =>
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
    const taskTools = msg.tool_uses?.filter((t) => t.name === 'Task') || [];
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

  // Add compaction blocks, inserting them at the correct position based on first message's index
  // Sort compaction events by their first message's index
  const compactionBlocks: Array<{ block: Block; index: number }> = [];
  for (const compactionMessages of compactionEventsByTask.values()) {
    if (compactionMessages.length > 0) {
      // Sort messages within each compaction group (start should come before complete)
      const sortedMessages = [...compactionMessages].sort((a, b) => a.index - b.index);
      compactionBlocks.push({
        block: { type: 'compaction', messages: sortedMessages },
        index: sortedMessages[0].index, // Use first message's index for positioning
      });
    }
  }

  // Insert compaction blocks at their correct positions
  for (const { block, index: compactionIndex } of compactionBlocks) {
    // Find where to insert based on message index
    let insertPosition = 0;
    for (let i = 0; i < blocks.length; i++) {
      const currentBlock = blocks[i];
      const blockIndex =
        currentBlock.type === 'message'
          ? currentBlock.message.index
          : (currentBlock.messages[0]?.index ?? 0);

      if (blockIndex < compactionIndex) {
        insertPosition = i + 1;
      } else {
        break;
      }
    }
    blocks.splice(insertPosition, 0, block);
  }

  return blocks;
}

export const TaskBlock = React.memo<TaskBlockProps>(
  ({
    task,
    client,
    agentic_tool,
    sessionModel,
    userById = new Map(),
    currentUserId,
    isExpanded,
    onExpandChange,
    sessionId,
    onPermissionDecision,
    worktreeName,
    scheduledFromWorktree,
    scheduledRunAt,
    streamingMessages,
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

    // Convert streaming messages map to array once the reference changes
    const streamingForTask = useMemo(
      () => (streamingMessages ? Array.from(streamingMessages.values()) : []),
      [streamingMessages]
    );

    // Merge task messages with streaming messages (for running tasks)
    const messages = useMemo(() => {
      const dbOnlyMessages =
        streamingMessages && streamingMessages.size > 0
          ? taskMessages.filter((msg) => !streamingMessages.has(msg.message_id))
          : taskMessages;

      return ([...dbOnlyMessages, ...streamingForTask] as Message[]).sort(
        (a, b) => a.index - b.index
      );
    }, [taskMessages, streamingForTask, streamingMessages]);

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

    // Get normalized SDK response (computed by executor, stored in DB)
    const normalized = task.normalized_sdk_response || null;

    // Use computed context window from database (already summed across tasks since last compaction)
    // If undefined, it means the backend computation failed or hasn't run yet
    const contextWindowUsed = task.computed_context_window ?? 0;
    const contextWindowLimit = normalized?.contextWindowLimit ?? 200000;
    const taskHeaderGradient = getContextWindowGradient(contextWindowUsed, contextWindowLimit);

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
          <Typography.Text ellipsis style={{ marginBottom: token.sizeUnit }}>
            {typeof task.description === 'string'
              ? task.description || 'User Prompt'
              : 'User Prompt'}
          </Typography.Text>

          {/* Task metadata */}
          <Flex wrap gap={token.sizeUnit}>
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
                userById={userById}
                prefix="By"
              />
            )}
            <MessageCountPill count={messageCount} />
            <ToolCountPill count={toolCount} />
            {normalized && (
              <TokenCountPill
                count={normalized.tokenUsage.totalTokens}
                inputTokens={normalized.tokenUsage.inputTokens}
                outputTokens={normalized.tokenUsage.outputTokens}
                cacheReadTokens={normalized.tokenUsage.cacheReadTokens}
                cacheCreationTokens={normalized.tokenUsage.cacheCreationTokens}
              />
            )}
            {(task.computed_context_window || normalized) && (
              <ContextWindowPill
                used={contextWindowUsed}
                limit={contextWindowLimit || 0}
                taskMetadata={{
                  model: task.model,
                  duration_ms: task.duration_ms,
                  agentic_tool,
                  raw_sdk_response: task.raw_sdk_response,
                }}
              />
            )}
            {task.model && task.model !== sessionModel && <ModelPill model={task.model} />}
            {task.git_state.sha_at_start && task.git_state.sha_at_start !== 'unknown' && (
              <Flex gap={token.sizeUnit / 2} align="center">
                <GitStatePill
                  branch={task.git_state.ref_at_start}
                  sha={task.git_state.sha_at_start}
                  worktreeName={worktreeName}
                  style={{ fontSize: 11 }}
                />
                {task.git_state.sha_at_end &&
                  task.git_state.sha_at_end !== 'unknown' &&
                  task.git_state.sha_at_end !== task.git_state.sha_at_start && (
                    <>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        →
                      </Typography.Text>
                      <GitStatePill
                        sha={task.git_state.sha_at_end}
                        worktreeName={worktreeName}
                        showDirtyIndicator={true}
                        style={{ fontSize: 11 }}
                      />
                    </>
                  )}
              </Flex>
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
        onChange={(keys) => onExpandChange(keys.length > 0)}
        expandIcon={() => null}
        style={{ background: 'transparent', margin: `${token.sizeUnit * 3}px 0` }}
        items={[
          {
            key: 'task-content',
            label: taskHeader,
            styles: {
              header: {
                padding: token.sizeUnit * 2,
                alignItems: 'flex-start',
                background: taskHeaderGradient || 'transparent',
                borderRadius: isExpanded ? '8px 8px 0 0' : 8,
              },
              body: {
                background: 'transparent',
                padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 2}px`,
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
                          isFirstPending = !blocks.slice(0, blockIndex).some((b) => {
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
                          userById={userById}
                          currentUserId={task.created_by}
                          isTaskRunning={task.status === TaskStatus.RUNNING}
                          sessionId={sessionId}
                          onPermissionDecision={onPermissionDecision}
                          isFirstPendingPermission={isFirstPending}
                          isLatestMessage={isLatestMessage}
                          taskId={task.task_id}
                          allMessages={messages}
                        />
                      );
                    }
                    if (block.type === 'agent-chain') {
                      // Use first message ID as key for agent chain
                      const blockKey = `agent-chain-${block.messages[0]?.message_id || 'unknown'}`;
                      return <AgentChain key={blockKey} messages={block.messages} />;
                    }
                    if (block.type === 'compaction') {
                      // Render compaction block with aggregated messages
                      const blockKey = `compaction-${block.messages[0]?.message_id || 'unknown'}`;
                      return (
                        <CompactionBlock
                          key={blockKey}
                          messages={block.messages}
                          agentic_tool={agentic_tool}
                        />
                      );
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
