/** TaskBlock renders one continuous turn, with lazy supporting activity and hover metadata. */

import {
  AUTHORIZATION_REVOKED_TERMINATION_MESSAGE,
  isTaskExecuting,
  isTerminalTaskStatus,
} from '@agor/core/types';
import type { AgenticToolName, AgorClient, StreamingMessageState } from '@agor-live/client';
import {
  hasMinimumRole,
  type MCPRuntimeRecovery,
  type Message,
  MessageRole,
  type PermissionRequestContent,
  type PermissionScope,
  PermissionStatus,
  ROLES,
  type SessionID,
  type Task,
  TaskStatus,
  type ToolExecutionState,
  type User,
} from '@agor-live/client';
// TODO: Move normalization to DB or daemon API
import { FileTextOutlined, GithubOutlined, RobotOutlined } from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Alert, Button, Flex, Typography, theme } from 'antd';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getContextWindowGradient } from '../../utils/contextWindow';
import { AgentChain } from '../AgentChain';
import { AgorAvatar } from '../AgorAvatar';
import { CompactionBlock } from '../CompactionBlock';
import { MessageBlock } from '../MessageBlock';
import { CreatedByTag } from '../metadata/CreatedByTag';
import {
  ContextWindowPill,
  GitStatePill,
  ModelPill,
  ScheduledRunPill,
  TimerPill,
  TokenCountPill,
} from '../Pill';
import { RateLimitBlock } from '../RateLimitBlock';
import { StickyTodoRenderer } from '../StickyTodoRenderer';
import { Tag } from '../Tag';
import { ToolDisclosureHeader } from '../ToolBlock/ToolBlock';
import { ToolIcon } from '../ToolIcon';
import { LeanTurnMetadata } from './LeanTurnMetadata';
import { TurnOutcome } from './TurnOutcome';

const { Paragraph } = Typography;

// Default-param `= new Map()` would mint a fresh Map per render and defeat
// the MessageBlock memos below whenever the prop is omitted.
const EMPTY_USER_MAP = new Map<string, User>();

/**
 * Block types for rendering
 */
export type Block =
  | { type: 'message'; message: Message }
  | { type: 'agent-chain'; messages: Message[]; parentToolUseId?: string }
  | { type: 'compaction'; messages: Message[] }; // System messages (start + optional complete)

interface TaskBlockProps {
  task: Task;
  agentic_tool?: string;
  sessionModel?: string;
  userById?: Map<string, User>;
  currentUserId?: string;
  sessionId?: SessionID | null;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
  branchName?: string;
  scheduledFromBranch?: boolean;
  scheduledRunAt?: number;
  streamingMessages?: Map<string, StreamingMessageState>;
  taskMessages: Message[];
  taskMessagesLoaded: boolean;
  onLoadTaskMessages: (taskId: string) => Promise<void> | void;
  teammateEmoji?: string;
  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;
  /** Authenticated Feathers client, forwarded to MessageBlock → WidgetBlock for inline submission. */
  client?: AgorClient | null;
  /** Whether this is the most recent task in the session */
  isLatestTask?: boolean;
  /** Phone-sized transcript presentation without desktop-only indents or gradients. */
  compact?: boolean;
  latestActivity?: ToolExecutionState;
}

/**
 * Check if a system message is an SDK status event (rate limit, API wait, or other SDK event).
 * These render via RateLimitBlock instead of the regular MessageBlock.
 */
function isSdkStatusMessage(message: Message): boolean {
  if (message.role !== MessageRole.SYSTEM || !Array.isArray(message.content)) return false;
  return message.content.some(
    (b) => b.type === 'rate_limit' || b.type === 'api_wait' || b.type === 'sdk_event'
  );
}

/** Durable outcome projection; re-renders are inherently idempotent. */
export function isVerifiedRuntimeInterruption(task: Task, isLatestTask = false): boolean {
  return (
    isLatestTask &&
    task.status === TaskStatus.FAILED &&
    task.sdk_failure?.termination === 'verified' &&
    task.termination_request?.cause !== 'user_stop' &&
    task.termination_request?.cause !== 'authorization_revoked'
  );
}

/** Authorization withdrawal is already durable on the Task; no transcript row is needed. */
export function isAuthorizationRevokedFailure(task: Task): boolean {
  return (
    task.status === TaskStatus.FAILED && task.termination_request?.cause === 'authorization_revoked'
  );
}

/** Presentation policy: keep STOPPING output visible until a durable terminal projection arrives. */
export function shouldRenderLiveTaskProgress(task: Task): boolean {
  return task.status === TaskStatus.RUNNING || task.status === TaskStatus.STOPPING;
}

function RuntimeInterruptionNotice({
  task,
  sessionId,
  client,
}: {
  task: Task;
  sessionId?: SessionID | null;
  client?: AgorClient | null;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [resumed, setResumed] = useState(false);
  const handleResume = async () => {
    if (!client || !sessionId) return;
    setSubmitting(true);
    try {
      // This deliberately starts a new durable Task. It never attempts to
      // revive the failed Task or reuse its executor ownership.
      await client.sessions.prompt(
        sessionId,
        'Continue from the interrupted task. Inspect the previous task state first, then continue safely.'
      );
      setResumed(true);
    } catch (error) {
      console.error('Failed to resume after runtime interruption:', error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="Task interrupted"
      description={
        <>
          {task.sdk_failure?.reason === 'startup_timeout'
            ? 'The executor did not start in time. Agor verified containment before making this session promptable.'
            : 'Agor lost contact with the executor and verified containment before making this session promptable.'}
          {task.error_message && <div>{task.error_message}</div>}
        </>
      }
      action={
        client && sessionId && !resumed ? (
          <Button size="small" type="primary" loading={submitting} onClick={handleResume}>
            Resume in new task
          </Button>
        ) : undefined
      }
    />
  );
}

function AuthorizationRevokedNotice({ task }: { task: Task }) {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      title="Task access revoked"
      description={task.error_message || AUTHORIZATION_REVOKED_TERMINATION_MESSAGE}
    />
  );
}

export function MCPRecoveryNotice({
  task,
  recovery,
  client,
  canRequestReconnect = false,
}: {
  task: Task;
  recovery: MCPRuntimeRecovery;
  client?: AgorClient | null;
  canRequestReconnect?: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const { token } = theme.useToken();
  const isLiveTask =
    task.status === TaskStatus.RUNNING ||
    task.status === TaskStatus.AWAITING_PERMISSION ||
    task.status === TaskStatus.AWAITING_INPUT;
  const refreshExpired =
    recovery.status === 'refresh_requested' &&
    (!recovery.refresh_deadline_at || new Date(recovery.refresh_deadline_at).getTime() <= now);
  useEffect(() => {
    if (recovery.status !== 'refresh_requested' || !recovery.refresh_deadline_at) return;
    const delay = Math.max(0, new Date(recovery.refresh_deadline_at).getTime() - Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), delay + 10);
    return () => window.clearTimeout(timer);
  }, [recovery.refresh_deadline_at, recovery.status]);
  const canReconnect =
    isLiveTask &&
    recovery.action === 'reconnect_mcp' &&
    recovery.provider.transport_reload &&
    canRequestReconnect &&
    !!client;
  const reconnectForbidden =
    isLiveTask &&
    recovery.action === 'reconnect_mcp' &&
    recovery.provider.transport_reload &&
    !canRequestReconnect;
  const recoveryIdentity = [
    recovery.generation,
    recovery.status,
    recovery.code,
    recovery.action,
    recovery.request_id ?? '',
    recovery.observed_at,
    recovery.message,
    recovery.mcp_server_id ?? '',
  ].join(':');
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new durable identity clears a prior request's transient UI error
  useEffect(() => {
    setError(undefined);
  }, [recoveryIdentity]);

  const handleReconnect = async () => {
    if (!client || !canReconnect) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await client.service(`/tasks/${task.task_id}/mcp-reconnect`).create({
        generation: recovery.generation,
      });
    } catch {
      console.error('[TaskBlock] MCP reconnect request failed');
      setError('MCP recovery changed or could not be requested. Reload and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isLiveTask) return null;

  const title =
    recovery.status === 'refresh_requested'
      ? refreshExpired
        ? 'MCP reconnect needs confirmation'
        : 'Reconnecting MCP…'
      : recovery.action === 'reauthenticate'
        ? 'MCP sign-in required'
        : recovery.action === 'retry_next_turn'
          ? 'MCP updates apply next turn'
          : recovery.status === 'failed'
            ? 'MCP reconnect failed'
            : 'MCP configuration requires attention';
  const descriptionText =
    error ??
    (refreshExpired
      ? 'The automatic refresh hint expired or may have been missed. Reconnect MCP to retry transport setup without restarting the conversation.'
      : `${recovery.message}${
          reconnectForbidden
            ? ' Only the task creator or an administrator can request MCP reconnection.'
            : ''
        }`);
  const description = recovery.server_states?.length ? (
    <Flex vertical gap={4}>
      <span>{descriptionText}</span>
      <ul style={{ margin: 0, paddingInlineStart: 20 }}>
        {recovery.server_states.map((state) => (
          <li key={state.mcp_server_id}>
            <strong>{state.name}</strong>: {state.message}
          </li>
        ))}
      </ul>
    </Flex>
  ) : (
    descriptionText
  );

  return (
    <Alert
      role={recovery.status === 'failed' ? 'alert' : 'status'}
      aria-live={recovery.status === 'failed' ? 'assertive' : 'polite'}
      type={recovery.status === 'failed' ? 'error' : 'warning'}
      showIcon
      style={{ marginBottom: token.marginMD }}
      message={title}
      description={description}
      action={
        recovery.action === 'reauthenticate' && recovery.mcp_server_id ? (
          <Button
            size="small"
            type="primary"
            href={`/settings/mcp/${encodeURIComponent(recovery.mcp_server_id)}/`}
            aria-label={`Sign in to ${recovery.mcp_server_name ?? 'the affected MCP server'}`}
          >
            Sign in to {recovery.mcp_server_name ?? 'MCP server'}
          </Button>
        ) : canReconnect || reconnectForbidden ? (
          <Button
            size="small"
            type="primary"
            loading={submitting}
            onClick={handleReconnect}
            disabled={reconnectForbidden}
            title={
              reconnectForbidden
                ? 'Only the task creator or an administrator can reconnect MCP.'
                : undefined
            }
            aria-label="Reconnect MCP for this active task"
          >
            Reconnect MCP
          </Button>
        ) : undefined
      }
    />
  );
}

function messageHasTool(message: Message, toolUseId: string): boolean {
  return !!(
    message.tool_uses?.some((tool) => tool.id === toolUseId) ||
    (Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_use' && block.id === toolUseId))
  );
}

function isAgentChainMessage(message: Message): boolean {
  // EXCEPTION: User messages with ONLY tool_result blocks are part of agent execution
  // (tool results are technically "user" role per Anthropic API, but they're automated responses)
  if (message.role === MessageRole.USER && Array.isArray(message.content)) {
    const hasOnlyToolResults = message.content.every((block) => block.type === 'tool_result');
    if (hasOnlyToolResults) return true; // Part of agent chain, don't break it
  }

  // Only agent messages beyond this point
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
    const hasText = message.content.some(
      (block) => block.type === 'text' && typeof block.text === 'string' && !!block.text.trim()
    );

    // SPECIAL: Task tools should display as regular agent messages, not in chain
    const hasOnlyTaskTool =
      message.content.length === 1 &&
      message.content[0].type === 'tool_use' &&
      (message.content[0] as { name?: string }).name === 'Task';

    if (hasOnlyTaskTool) {
      return false; // Show as regular message bubble
    }

    // User-facing text wins over thinking/tool activity. MessageBlock already
    // separates the visible response from its supporting activity.
    if (hasText) return false;

    // Only tools/thinking, no text = pure agent chain
    if (hasTools || hasThinking) return true;

    // An empty streaming text placeholder is not a user-facing boundary.
    if (message.content.every((block) => block.type === 'text')) return true;

    // Other content stays in its dedicated message renderer.
    return false;
  }

  return false;
}

/**
 * Group messages into blocks:
 * - Consecutive agent messages with thoughts/tools → AgentChain
 * - User messages and agent text responses → individual MessageBlocks
 * - Task tool nested operations → AgentChain (grouped by parent_tool_use_id)
 * - Compaction events (system_status + system_complete) → Compaction block
 * - Permission requests are now just messages, rendered inline naturally
 */
export function groupMessagesIntoBlocks(messages: Message[]): Block[] {
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
        blocks.push({ type: 'agent-chain', messages: chainMessages, parentToolUseId: taskTool.id });
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

  // Display-order only: stable-move widget_request blocks to the END of the
  // task's block list so an inline widget (e.g. the gateway token form) renders
  // BELOW the agent's closing text for the same turn — making it the last thing
  // the user sees. Widgets are stamped at tool-call time (mid-turn), so by
  // message index they'd otherwise sort above the agent's closing explanation.
  // Non-widget blocks keep their original order; widget blocks keep their
  // relative order at the end. This touches render order ONLY — message.index /
  // identity (genealogy markers, streaming, React keys) are untouched.
  const isWidgetBlock = (b: Block): boolean =>
    b.type === 'message' && b.message.type === 'widget_request';
  if (blocks.some(isWidgetBlock)) {
    return [...blocks.filter((b) => !isWidgetBlock(b)), ...blocks.filter(isWidgetBlock)];
  }

  return blocks;
}

/**
 * Identity key for reconciling a block across renders — mirrors the React
 * `key` each block type renders with.
 */
function getBlockKey(block: Block): string {
  return block.type === 'message'
    ? `m:${block.message.message_id}`
    : `${block.type}:${block.messages[0]?.message_id || 'unknown'}`;
}

/**
 * Marker value for a block's `data-conversation-block` wrapper. In-session
 * search re-scans on the 'streaming' → 'settled' attribute flip: a message
 * that finishes streaming settles inside the SAME wrapper node (same key), so
 * without the flip its final text would only become findable at the next
 * block mount/unmount.
 */
function getBlockMarker(block: Block): 'streaming' | 'settled' {
  const messages = block.type === 'message' ? [block.message] : block.messages;
  return messages.some((m) => (m as { isStreaming?: boolean }).isStreaming === true)
    ? 'streaming'
    : 'settled';
}

/** Same render composition: grouping ownership and ordered message references. */
function blocksHaveSameComposition(a: Block, b: Block): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'message' && b.type === 'message') return a.message === b.message;
  if (
    a.type === 'agent-chain' &&
    b.type === 'agent-chain' &&
    a.parentToolUseId !== b.parentToolUseId
  )
    return false;
  const aMessages = (a as { messages: Message[] }).messages;
  const bMessages = (b as { messages: Message[] }).messages;
  if (aMessages.length !== bMessages.length) return false;
  return aMessages.every((msg, i) => msg === bMessages[i]);
}

export const TaskBlock = React.memo<TaskBlockProps>(
  ({
    task,
    agentic_tool,
    sessionModel,
    userById = EMPTY_USER_MAP,
    currentUserId,
    sessionId,
    onPermissionDecision,
    branchName,
    scheduledFromBranch,
    scheduledRunAt,
    streamingMessages,
    taskMessages,
    taskMessagesLoaded,
    onLoadTaskMessages,
    teammateEmoji,
    onOpenAgenticToolSettings,
    isLatestTask = false,
    client = null,
    compact = false,
    latestActivity,
  }) => {
    const { token } = theme.useToken();
    const runtimeLive = shouldRenderLiveTaskProgress(task);
    const currentUser = currentUserId ? userById.get(currentUserId) : undefined;
    const canRequestMcpReconnect =
      currentUserId === task.created_by || hasMinimumRole(currentUser?.role, ROLES.ADMIN);

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

    // Group messages into blocks, then reconcile against the previous render:
    // a streaming chunk rebuilds `messages` (new array identity) every frame,
    // but only the streamed message's block actually changed. Reusing the
    // previous block objects — and crucially their `messages` arrays, which
    // are minted fresh by groupMessagesIntoBlocks — keeps the props of the
    // memoized AgentChain/CompactionBlock children reference-stable, so the
    // untouched (often large) tool-chain subtrees bail out of re-rendering.
    const prevBlocksRef = useRef<Block[]>([]);
    const blocks = useMemo(() => {
      const next = groupMessagesIntoBlocks(
        messages.filter((message) => !Array.isArray(message.content) || message.content.length > 0)
      );
      const prevByKey = new Map(prevBlocksRef.current.map((b) => [getBlockKey(b), b]));
      const reconciled = next.map((block) => {
        const prev = prevByKey.get(getBlockKey(block));
        return prev && blocksHaveSameComposition(prev, block) ? prev : block;
      });
      prevBlocksRef.current = reconciled;
      return reconciled;
    }, [messages]);

    // Index of the last agent-chain block — used for isLatest so that a streaming
    // text bubble appearing after the chain doesn't prematurely collapse it
    const lastAgentChainIndex = useMemo(() => {
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].type === 'agent-chain') return i;
      }
      return -1;
    }, [blocks]);

    const activityIsRecorded =
      !!latestActivity &&
      messages.some((message) => messageHasTool(message, latestActivity.toolUseId));
    // Events and messages arrive independently. An unpersisted next call belongs
    // to the contiguous tail, not a second disclosure beside that same chain.
    // Do not cross a response/approval/compaction or borrow a nested Task chain.
    const trailingChain = blocks.at(-1);
    const pendingActivityChainIndex =
      latestActivity &&
      !activityIsRecorded &&
      runtimeLive &&
      trailingChain?.type === 'agent-chain' &&
      !trailingChain.parentToolUseId &&
      trailingChain.messages.every((message) => !message.parent_tool_use_id)
        ? blocks.length - 1
        : -1;

    // Get normalized SDK response (computed by executor, stored in DB)
    const normalized = task.normalized_sdk_response || null;

    // Use computed context window from database (already summed across tasks since last compaction)
    // If undefined, it means the backend computation failed or hasn't run yet
    const contextSnapshot = normalized?.contextUsageSnapshot;
    const hasContextWindowUsage =
      !!contextSnapshot ||
      (typeof task.computed_context_window === 'number' && task.computed_context_window > 0);
    const contextWindowUsed = task.computed_context_window ?? contextSnapshot?.totalTokens ?? 0;
    const contextWindowLimit = contextSnapshot?.maxTokens ?? normalized?.contextWindowLimit ?? 0;
    const taskHeaderGradient = hasContextWindowUsage
      ? getContextWindowGradient(contextWindowUsed, contextWindowLimit, contextSnapshot, {
          normal: token.colorSuccessBg,
          warning: token.colorWarningBg,
          critical: token.colorErrorBg,
        })
      : undefined;

    const hasPendingApproval =
      task.status === TaskStatus.AWAITING_PERMISSION ||
      messages.some(
        (message) =>
          message.type === 'permission_request' &&
          (message.content as PermissionRequestContent)?.status === PermissionStatus.PENDING
      );

    const metadataPills = (
      <Flex
        wrap={false}
        gap={token.sizeUnit}
        align="center"
        style={{ width: 'max-content', flexShrink: 0 }}
      >
        <TimerPill
          status={task.status}
          startedAt={task.started_at || task.message_range?.start_timestamp || task.created_at}
          endedAt={
            task.completed_at ||
            (task.message_range?.end_timestamp !== task.message_range?.start_timestamp
              ? task.message_range?.end_timestamp
              : undefined)
          }
          durationMs={task.duration_ms}
          lastExecutorHeartbeatAt={task.last_executor_heartbeat_at}
          latestExecutorPulse={task.latest_executor_pulse}
        />
        {scheduledFromBranch && scheduledRunAt && (
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
        {normalized && (
          <TokenCountPill
            count={normalized.tokenUsage.totalTokens}
            inputTokens={normalized.tokenUsage.inputTokens}
            outputTokens={normalized.tokenUsage.outputTokens}
            cacheReadTokens={normalized.tokenUsage.cacheReadTokens}
            cacheCreationTokens={normalized.tokenUsage.cacheCreationTokens}
          />
        )}
        {hasContextWindowUsage && (
          <ContextWindowPill
            used={contextWindowUsed}
            limit={contextWindowLimit || 0}
            taskMetadata={{
              model: task.model,
              duration_ms: task.duration_ms,
              agentic_tool,
              raw_sdk_response: task.raw_sdk_response,
              normalized_sdk_response: normalized ?? undefined,
            }}
          />
        )}
        {task.model && task.model !== sessionModel && <ModelPill model={task.model} />}
        {task.git_state.sha_at_start && task.git_state.sha_at_start !== 'unknown' && (
          <Flex gap={token.sizeUnit / 2} align="center">
            <GitStatePill
              branch={task.git_state.ref_at_start}
              sha={task.git_state.sha_at_start}
              branchName={branchName}
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
                    branch={task.git_state.ref_at_end}
                    sha={task.git_state.sha_at_end}
                    branchName={branchName}
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
    );

    const [detailsError, setDetailsError] = useState<string | null>(null);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [revealLoadedActivity, setRevealLoadedActivity] = useState(false);
    const [emptyActivityExpanded, setEmptyActivityExpanded] = useState(false);
    const firstAgentChainIndex = blocks.findIndex((block) => block.type === 'agent-chain');
    const loadActivity = async () => {
      setDetailsLoading(true);
      setDetailsError(null);
      setRevealLoadedActivity(true);
      setEmptyActivityExpanded(true);
      try {
        await onLoadTaskMessages(task.task_id);
      } catch {
        setDetailsError('Could not load tool activity. Try again.');
      } finally {
        setDetailsLoading(false);
      }
    };
    const firstPromptId = messages.find(
      (message) =>
        message.role === MessageRole.USER &&
        (typeof message.content === 'string'
          ? !!message.content
          : Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'text' || block.type === 'image'))
    )?.message_id;
    const hasTools = messages.some(
      (message) =>
        message.tool_uses?.length ||
        (Array.isArray(message.content) &&
          message.content.some(
            (block) => block.type === 'tool_use' || block.type === 'tool_result'
          ))
    );
    const hasDeferredReasoning = messages.some((message) => message.has_deferred_reasoning);
    const hasReasoning = messages.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((block) => block.type === 'thinking')
    );
    const toolDisclosure = (task.recorded_tool_count !== 0 ||
      hasDeferredReasoning ||
      hasReasoning ||
      hasTools ||
      latestActivity ||
      !isTerminalTaskStatus(task.status)) && (
      <div style={{ marginBottom: token.marginSM }}>
        {!taskMessagesLoaded && !hasTools && !hasReasoning && !isTaskExecuting(task) ? (
          <ToolDisclosureHeader
            count={task.recorded_tool_count}
            label={
              detailsLoading
                ? 'Loading tool activity…'
                : detailsError
                  ? 'Couldn’t load tool activity · Retry'
                  : task.recorded_tool_count != null && task.recorded_tool_count > 0
                    ? 'Tool calls'
                    : hasDeferredReasoning
                      ? task.recorded_tool_count === 0
                        ? 'Reasoning'
                        : 'Tool calls and reasoning'
                      : 'Tool calls'
            }
            expanded={false}
            loading={detailsLoading}
            onClick={loadActivity}
          />
        ) : taskMessagesLoaded && !hasTools && !hasReasoning && !isTaskExecuting(task) ? (
          <>
            <ToolDisclosureHeader
              label="Tool calls"
              count={latestActivity ? undefined : 0}
              expanded={emptyActivityExpanded}
              onClick={() => setEmptyActivityExpanded(!emptyActivityExpanded)}
            />
            {emptyActivityExpanded && (
              <div
                style={{
                  fontSize: token.fontSizeSM,
                  color: token.colorTextSecondary,
                  paddingInlineStart: token.marginSM,
                }}
              >
                {latestActivity
                  ? 'Tool activity was observed, but no details are recorded for this turn'
                  : 'No tool calls'}
              </div>
            )}
          </>
        ) : null}
      </div>
    );
    const taskContent = (
      <div style={{ paddingTop: token.sizeUnit }}>
        {isLatestTask &&
          (task.status === TaskStatus.RUNNING ||
            task.status === TaskStatus.AWAITING_PERMISSION ||
            task.status === TaskStatus.AWAITING_INPUT) &&
          task.metadata?.mcp_recovery && (
            <MCPRecoveryNotice
              task={task}
              recovery={task.metadata.mcp_recovery}
              client={client}
              canRequestReconnect={canRequestMcpReconnect}
            />
          )}
        {/* Render all blocks (messages and agent chains). Each block
                      gets a `data-conversation-block` wrapper: in-session
                      search's MutationObserver keys off these boundaries to
                      tell structural transcript changes (new message/chain,
                      task hydration, a block settling after streaming) apart
                      from per-frame streaming churn inside a block. */}
        {blocks.map((block, blockIndex) => {
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

            // Render SDK status messages (rate limit, API wait, etc.) with dedicated component
            if (isSdkStatusMessage(block.message)) {
              return (
                <div key={block.message.message_id} data-conversation-block={getBlockMarker(block)}>
                  <RateLimitBlock message={block.message} agentic_tool={agentic_tool} />
                </div>
              );
            }

            // Check if this is the latest agent message (last message block)
            const isLatestMessage =
              block.message.role === MessageRole.ASSISTANT && blockIndex === blocks.length - 1;

            const messageElement = (
              <MessageBlock
                key={block.message.message_id}
                message={block.message}
                agentic_tool={agentic_tool}
                userById={userById}
                currentUserId={task.created_by}
                isTaskRunning={runtimeLive}
                sessionId={sessionId}
                onPermissionDecision={onPermissionDecision}
                isFirstPendingPermission={isFirstPending}
                isLatestMessage={isLatestMessage}
                taskId={task.task_id}
                teammateEmoji={teammateEmoji}
                client={client}
                onOpenAgenticToolSettings={onOpenAgenticToolSettings}
                compact={compact}
              />
            );
            return (
              <div key={block.message.message_id} data-conversation-block={getBlockMarker(block)}>
                {block.message.message_id === firstPromptId ? (
                  <>
                    <LeanTurnMetadata
                      metadata={metadataPills}
                      background={taskHeaderGradient}
                      reserveSpace={hasPendingApproval}
                    >
                      {messageElement}
                    </LeanTurnMetadata>
                    {toolDisclosure}
                  </>
                ) : (
                  messageElement
                )}
              </div>
            );
          }
          if (block.type === 'agent-chain') {
            // Use first message ID as key for agent chain
            const blockKey = `agent-chain-${block.messages[0]?.message_id || 'unknown'}`;
            return (
              <div key={blockKey} data-conversation-block={getBlockMarker(block)}>
                <AgentChain
                  messages={block.messages}
                  revealRequested={revealLoadedActivity && blockIndex === firstAgentChainIndex}
                  latestActivity={
                    blockIndex === pendingActivityChainIndex ||
                    (blockIndex === lastAgentChainIndex &&
                      latestActivity &&
                      block.messages.some((message) =>
                        messageHasTool(message, latestActivity.toolUseId)
                      ))
                      ? latestActivity
                      : undefined
                  }
                  isTaskRunning={runtimeLive && !hasPendingApproval}
                  isLatest={isLatestTask && blockIndex === lastAgentChainIndex}
                  hasFollowingResponse={blocks
                    .slice(blockIndex + 1)
                    .some(
                      (next) =>
                        next.type === 'message' &&
                        next.message.role === MessageRole.ASSISTANT &&
                        (typeof next.message.content === 'string'
                          ? !!next.message.content.trim()
                          : Array.isArray(next.message.content) &&
                            next.message.content.some(
                              (content) =>
                                content.type === 'text' &&
                                typeof content.text === 'string' &&
                                !!content.text.trim()
                            ))
                    )}
                  compact={compact}
                />
              </div>
            );
          }
          if (block.type === 'compaction') {
            // Render compaction block with aggregated messages
            const blockKey = `compaction-${block.messages[0]?.message_id || 'unknown'}`;
            return (
              <div key={blockKey} data-conversation-block={getBlockMarker(block)}>
                <CompactionBlock messages={block.messages} agentic_tool={agentic_tool} />
              </div>
            );
          }
          return null;
        })}

        {/* Before the first chain (or after a real boundary), an unrecorded
            event still needs its own disclosure. Contiguous tail activity is
            owned by AgentChain above, including during partial persistence. */}
        {latestActivity &&
          runtimeLive &&
          !activityIsRecorded &&
          pendingActivityChainIndex === -1 && (
            <ToolDisclosureHeader
              count={1}
              label={`${latestActivity.status === 'executing' ? 'Running' : 'Latest'}: ${latestActivity.toolName}`}
              expanded={false}
              loading={detailsLoading}
              executing={task.status === TaskStatus.RUNNING && !hasPendingApproval}
              onClick={loadActivity}
            />
          )}
        {detailsError && !(!taskMessagesLoaded && !isTaskExecuting(task)) && (
          <Alert type="error" title={detailsError} />
        )}

        {/* Keep latest TODO visible even after completion (Claude parity). */}
        <StickyTodoRenderer messages={messages} taskStatus={task.status} />

        {/* Show typing indicator whenever the executor may still be live.
                      Marked as a conversation block so its unmount at stream
                      end gives search one final structural re-scan that picks
                      up the finished message text. */}
        {runtimeLive && (
          <div data-conversation-block style={{ margin: `${token.sizeUnit}px 0` }}>
            <Bubble
              placement="start"
              avatar={
                teammateEmoji ? (
                  <AgorAvatar>{teammateEmoji}</AgorAvatar>
                ) : agentic_tool ? (
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
              background: token.colorFillAlter,
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
                background: token.colorSuccessBg,
                border: `1px solid ${token.colorSuccessBorder}`,
                borderRadius: token.borderRadius,
                fontSize: 13,
                whiteSpace: 'pre-wrap',
              }}
            >
              {typeof task.report === 'string' ? task.report : JSON.stringify(task.report, null, 2)}
            </Paragraph>
          </div>
        )}
      </div>
    );
    return (
      <div data-task-block={task.task_id}>
        {!firstPromptId && (
          <>
            {task.full_prompt && (
              <LeanTurnMetadata
                metadata={metadataPills}
                background={taskHeaderGradient}
                reserveSpace={hasPendingApproval}
              >
                <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                  {task.full_prompt}
                </Typography.Paragraph>
              </LeanTurnMetadata>
            )}
            {toolDisclosure}
          </>
        )}
        {taskContent}
        {isAuthorizationRevokedFailure(task) ? (
          <AuthorizationRevokedNotice task={task} />
        ) : isVerifiedRuntimeInterruption(task, isLatestTask) ? (
          <RuntimeInterruptionNotice task={task} sessionId={sessionId} client={client} />
        ) : (
          <TurnOutcome task={task} />
        )}
      </div>
    );
  }
);

TaskBlock.displayName = 'TaskBlock';
