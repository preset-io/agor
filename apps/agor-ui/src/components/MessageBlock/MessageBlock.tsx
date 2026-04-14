/**
 * MessageBlock - Renders individual messages with support for structured content
 *
 * Handles:
 * - Text content (string or TextBlock)
 * - Tool use blocks
 * - Tool result blocks
 * - User vs Assistant styling
 * - User emoji avatars
 */

import {
  type ContentBlock as CoreContentBlock,
  type DiffEnrichment,
  type InputRequestContent,
  InputRequestStatus,
  type Message,
  type PermissionRequestContent,
  PermissionScope,
  PermissionStatus,
  type User,
} from '@agor-live/client';
import { RobotOutlined } from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Tooltip, theme } from 'antd';

import type React from 'react';
import { formatTimestampWithRelative } from '../../utils/time';
import { getToolDisplayName } from '../../utils/toolDisplayName';
import { toolResultToDisplayText } from '../../utils/toolResultToDisplayText';
import { AgorAvatar } from '../AgorAvatar';
import { CollapsibleMarkdown } from '../CollapsibleText/CollapsibleMarkdown';
import { CopyableContent } from '../CopyableContent';
import { InputRequestBlock } from '../InputRequestBlock';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { PermissionRequestBlock } from '../PermissionRequestBlock';
import { ThinkingBlock } from '../ThinkingBlock';
import {
  ALWAYS_EXPANDED_TOOLS,
  buildBashDescriptionNode,
  deriveToolStatus,
  IMPLICIT_RESULT_TOOLS,
  renderToolStatusIcon,
  ToolBlock,
} from '../ToolBlock';
import { ToolIcon } from '../ToolIcon';
import { ToolUseRenderer } from '../ToolUseRenderer';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | CoreContentBlock[];
  is_error?: boolean;
  diff?: DiffEnrichment;
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface ThinkingContentBlock {
  type: 'thinking';
  text: string;
  signature?: string;
}

interface MessageBlockProps {
  message:
    | Message
    | (Message & { isStreaming?: boolean; thinkingContent?: string; isThinking?: boolean });
  userById?: Map<string, User>;
  currentUserId?: string;
  isTaskRunning?: boolean; // Whether the task is running (for loading state)
  agentic_tool?: string; // Agentic tool name for showing tool icon
  sessionId?: string | null;
  taskId?: string;
  isFirstPendingPermission?: boolean; // For sequencing permission requests
  isFirstPendingInput?: boolean; // For sequencing input requests
  isLatestMessage?: boolean; // Whether this is the most recent message (don't collapse by default)
  allMessages?: Message[]; // All messages for aggregation (e.g., finding matching compaction events)
  assistantEmoji?: string; // Emoji override for assistant avatar (replaces tool icon)
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
  onInputResponse?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    answers: Record<string, string>,
    annotations?: Record<string, { markdown?: string; notes?: string }>
  ) => void;
}

/** Get short description for a tool call (file path, pattern, command, etc.) */
function getToolDescription(toolUse: ToolUseBlock): string | undefined {
  const { name, input } = toolUse;
  if (typeof input.description === 'string') return input.description;
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return input.file_path ? String(input.file_path) : undefined;
    case 'Bash':
      return input.description
        ? String(input.description)
        : input.command
          ? String(input.command)
          : undefined;
    case 'Grep':
    case 'Glob':
      return input.pattern ? String(input.pattern) : undefined;
    case 'ToolSearch':
    case 'WebSearch':
    case 'web_search':
      return input.query ? String(input.query) : undefined;
    case 'WebFetch':
      return input.url ? String(input.url) : undefined;
    case 'Agent':
      return input.description ? String(input.description) : undefined;
    case 'Skill':
    case 'SlashCommand':
      return input.skill ? String(input.skill) : input.name ? String(input.name) : undefined;
    case 'Task': {
      if (!input.prompt) return undefined;
      const firstLine = String(input.prompt).trim().split('\n')[0];
      return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      if (todos.length === 0) return undefined;
      const done = todos.filter((t: { status?: string }) => t.status === 'completed').length;
      const inProg = todos.filter((t: { status?: string }) => t.status === 'in_progress').length;
      const parts = [`${done}/${todos.length} done`];
      if (inProg > 0) parts.push(`${inProg} in progress`);
      return parts.join(', ');
    }
    case 'edit_files': {
      const changes = Array.isArray(input.changes) ? input.changes : [];
      if (changes.length === 0) return undefined;
      if (changes.length === 1) {
        const c = changes[0] as { path?: string; kind?: string };
        return `${c.kind || 'update'} ${c.path || ''}`;
      }
      return `${changes.length} files`;
    }
    default:
      return undefined;
  }
}

/**
 * Check if this is a Task tool prompt message (agent-generated, appears as user message)
 *
 * Task tool prompts are user role messages with array content containing text blocks.
 * These are NOT real user messages - they're the prompts the agent sends to subsessions.
 */
function isTaskToolPrompt(message: Message): boolean {
  // Must be user role
  if (message.role !== 'user') return false;

  // Must have array content (not string)
  if (!Array.isArray(message.content)) return false;

  // Must have at least one text block (not tool_result)
  const hasTextBlock = message.content.some((block) => block.type === 'text');
  const hasOnlyTextBlocks = message.content.every(
    (block) => block.type === 'text' || block.type === 'thinking'
  );

  // If it has text blocks and NO tool_result blocks, it's likely a Task prompt
  return hasTextBlock && hasOnlyTextBlocks;
}

/**
 * Check if this is a Task tool result message (should display as agent message)
 */
function isTaskToolResult(message: Message): boolean {
  // Must be user role with array content
  if (message.role !== 'user' || !Array.isArray(message.content)) return false;

  // Check if contains tool_result block
  // Note: We can't easily determine if it's specifically a Task result here,
  // but groupMessagesIntoBlocks ensures only Task results reach this as non-chain messages
  const hasToolResult = message.content.some((block) => block.type === 'tool_result');

  // User messages with tool_results that aren't in agent chains are likely Task results
  return hasToolResult;
}

/**
 * Compute the avatar element for an agent/assistant message.
 * Centralizes the priority: callback logo > assistant emoji > agentic tool icon > robot fallback.
 */
function getAgentAvatar({
  assistantEmoji,
  agentic_tool,
  isCallback,
  token,
}: {
  assistantEmoji?: string;
  agentic_tool?: string;
  isCallback?: boolean;
  token: ReturnType<typeof theme.useToken>['token'];
}): React.ReactNode {
  if (isCallback) {
    return (
      <img
        src={`${import.meta.env.BASE_URL}favicon.png`}
        alt="Agor"
        style={{ width: 32, height: 32, borderRadius: '50%' }}
      />
    );
  }
  if (assistantEmoji) {
    return <AgorAvatar>{assistantEmoji}</AgorAvatar>;
  }
  if (agentic_tool) {
    return <ToolIcon tool={agentic_tool} size={32} />;
  }
  return (
    <AgorAvatar icon={<RobotOutlined />} style={{ backgroundColor: token.colorBgContainer }} />
  );
}

export const MessageBlock: React.FC<MessageBlockProps> = ({
  message,
  userById = new Map(),
  currentUserId,
  isTaskRunning = false,
  agentic_tool,
  sessionId,
  taskId,
  isFirstPendingPermission = false,
  isFirstPendingInput = false,
  isLatestMessage = false,
  allMessages = [],
  onPermissionDecision,
  onInputResponse,
  assistantEmoji,
}) => {
  const { token } = theme.useToken();

  // Handle permission request messages specially
  if (message.type === 'permission_request') {
    const content = message.content as PermissionRequestContent;
    const isPending = content.status === PermissionStatus.PENDING;

    // Only allow interaction with the first pending permission request (sequencing)
    const canInteract = isPending && isFirstPendingPermission;

    return (
      <div style={{ margin: `${token.sizeUnit * 1.5}px 0` }}>
        <PermissionRequestBlock
          message={message}
          content={content}
          isActive={canInteract}
          agenticTool={agentic_tool}
          onApprove={
            canInteract && onPermissionDecision && sessionId && taskId
              ? (messageId, scope) => {
                  onPermissionDecision(sessionId, content.request_id, taskId, true, scope);
                }
              : undefined
          }
          onDeny={
            canInteract && onPermissionDecision && sessionId && taskId
              ? (_messageId) => {
                  onPermissionDecision(
                    sessionId,
                    content.request_id,
                    taskId,
                    false,
                    PermissionScope.ONCE
                  );
                }
              : undefined
          }
          isWaiting={isPending && !isFirstPendingPermission}
        />
      </div>
    );
  }

  // Handle input request messages (AskUserQuestion)
  if (message.type === 'input_request') {
    const content = message.content as InputRequestContent;
    const isPending = content.status === InputRequestStatus.PENDING;
    const canInteract = isPending && isFirstPendingInput;

    return (
      <div style={{ margin: `${token.sizeUnit * 1.5}px 0` }}>
        <InputRequestBlock
          message={message}
          content={content}
          isActive={canInteract}
          onSubmit={
            canInteract && onInputResponse && sessionId && taskId
              ? (_messageId, answers, annotations) => {
                  onInputResponse(sessionId, content.request_id, taskId, answers, annotations);
                }
              : undefined
          }
        />
      </div>
    );
  }

  // Check if this is a Task tool prompt or result (agent-generated, but has user role)
  const isTaskPrompt = isTaskToolPrompt(message);
  const isTaskResult = isTaskToolResult(message);
  const isSystem = message.role === 'system';
  const isCallback = message.metadata?.is_agor_callback === true;

  // Determine if this should be displayed as user or agent message
  const isUser = message.role === 'user' && !isTaskPrompt && !isTaskResult;
  const isAgent = message.role === 'assistant' || isTaskPrompt || isTaskResult || isSystem;

  // Check if message is currently streaming
  const isStreaming = 'isStreaming' in message && message.isStreaming === true;

  // Determine loading vs typing state:
  // - loading: task is running but no streaming chunks yet (waiting for first token)
  // - typing: streaming has started (we have content)
  const hasContent =
    typeof message.content === 'string'
      ? message.content.trim().length > 0
      : Array.isArray(message.content) && message.content.length > 0;
  const isLoading = isTaskRunning && !hasContent && isAgent;
  const shouldUseTyping = isStreaming && hasContent;

  // Get current user's emoji
  const currentUser = currentUserId ? userById.get(currentUserId) : undefined;
  const userEmoji = currentUser?.emoji || '👤';

  // Skip rendering if message has no content
  if (!message.content || (typeof message.content === 'string' && message.content.trim() === '')) {
    return null;
  }

  // Skip rendering if message has empty content array (can happen during patch events)
  if (Array.isArray(message.content) && message.content.length === 0) {
    return null;
  }

  // Special handling for system messages
  // Note: Compaction events are now handled by CompactionBlock in TaskBlock grouping
  if (isSystem && message.metadata?.is_btw_result) {
    const btwResponse =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              // biome-ignore lint/suspicious/noExplicitAny: Content block types vary
              .filter((b: any) => b.type === 'text')
              // biome-ignore lint/suspicious/noExplicitAny: Content block types vary
              .map((b: any) => b.text)
              .join('\n\n')
          : '';
    const btwPrompt = message.metadata?.btw_prompt as string | undefined;
    const btwSessionId = message.metadata?.btw_session_id as string | undefined;
    const btwShortId = btwSessionId ? btwSessionId.substring(0, 8) : undefined;
    const callerSessionId = message.metadata?.btw_caller_session_id as string | undefined;
    const callerTitle = message.metadata?.btw_caller_title as string | undefined;
    const callerShortId = callerSessionId ? callerSessionId.substring(0, 8) : undefined;
    const isRemote = !!callerSessionId;

    // Build markdown content
    const lines: string[] = [];
    if (isRemote) {
      const callerLink = callerTitle
        ? `[${callerTitle} (${callerShortId})](#session/${callerSessionId})`
        : `[${callerShortId}](#session/${callerSessionId})`;
      const forkLink = `[btw (${btwShortId})](#session/${btwSessionId})`;
      lines.push(`From ${callerLink} · ${forkLink}`);
    }
    if (btwPrompt) {
      lines.push(`> ${btwPrompt.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }
    lines.push(btwResponse);
    const markdownContent = lines.join('\n');

    return (
      <div
        style={{
          border: `1px solid ${token.colorWarning}`,
          borderRadius: token.borderRadiusLG,
          padding: '8px 12px',
          margin: '8px 0',
          background: token.colorWarningBg,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: token.colorWarning,
            marginBottom: 4,
          }}
        >
          btw
        </div>
        <MarkdownRenderer content={markdownContent} />
      </div>
    );
  }

  if (isSystem && Array.isArray(message.content)) {
    // Other system message types handled elsewhere (e.g., compaction in TaskBlock)
  }

  // Parse content blocks from message, preserving order
  const getContentBlocks = (): {
    thinkingBlocks: string[];
    textBeforeTools: string[];
    toolBlocks: { toolUse: ToolUseBlock; toolResult?: ToolResultBlock }[];
    textAfterTools: string[];
  } => {
    const thinkingBlocks: string[] = [];
    const textBeforeTools: string[] = [];
    const textAfterTools: string[] = [];
    const toolBlocks: { toolUse: ToolUseBlock; toolResult?: ToolResultBlock }[] = [];

    // Handle string content
    if (typeof message.content === 'string') {
      // Add Task tool prefix if this is a Task prompt
      const content = isTaskPrompt ? `[Task Tool]\n${message.content}` : message.content;
      return {
        thinkingBlocks: [],
        textBeforeTools: [content],
        toolBlocks: [],
        textAfterTools: [],
      };
    }

    // Handle array of content blocks
    if (Array.isArray(message.content)) {
      const toolUseMap = new Map<string, ToolUseBlock>();
      const toolResultMap = new Map<string, ToolResultBlock>();
      let hasSeenTool = false;

      // First pass: collect blocks and track order
      for (const block of message.content) {
        if (block.type === 'thinking') {
          const text = (block as unknown as ThinkingContentBlock).text;
          thinkingBlocks.push(text);
        } else if (block.type === 'text') {
          let text = (block as unknown as TextBlock).text;

          // Add Task tool prefix to the first text block if this is a Task prompt
          if (isTaskPrompt && textBeforeTools.length === 0 && !hasSeenTool) {
            text = `[Task Tool]\n${text}`;
          }

          if (hasSeenTool) {
            textAfterTools.push(text);
          } else {
            textBeforeTools.push(text);
          }
        } else if (block.type === 'tool_use') {
          const toolUse = block as unknown as ToolUseBlock;

          // Special handling: Task tools display as text, not tool blocks
          if (toolUse.name === 'Task') {
            // Store in tool map to check for results later
            toolUseMap.set(toolUse.id, toolUse);
            hasSeenTool = true;
          } else {
            // Regular tools go into tool map
            toolUseMap.set(toolUse.id, toolUse);
            hasSeenTool = true;
          }
        } else if (block.type === 'tool_result') {
          const toolResult = block as unknown as ToolResultBlock;
          toolResultMap.set(toolResult.tool_use_id, toolResult);

          // Special handling: If this is a Task tool result (user message rendered as agent),
          // extract text content and display it
          if (isTaskResult) {
            const resultText = toolResultToDisplayText(toolResult.content);

            if (resultText.trim()) {
              textBeforeTools.push(resultText);
            }
          }
        }
      }

      // Second pass: match tool_use with tool_result
      // Separate Task tools from regular tools
      for (const [id, toolUse] of toolUseMap.entries()) {
        if (toolUse.name === 'Task') {
          // Task tools: render as text message (spinner is shown in the tool chain)
          const subagentType = toolUse.input.subagent_type || 'Task';
          const description = toolUse.input.description || '';
          const taskText = `🔧 **Task (${subagentType}):** ${description}`;

          textBeforeTools.push(taskText);
        } else {
          // Regular tools
          toolBlocks.push({
            toolUse,
            toolResult: toolResultMap.get(id),
          });
        }
      }
    }

    return { thinkingBlocks, textBeforeTools, toolBlocks, textAfterTools };
  };

  const { thinkingBlocks, textBeforeTools, toolBlocks, textAfterTools } = getContentBlocks();

  // Also check for streaming thinking content
  const streamingThinking = 'thinkingContent' in message ? message.thinkingContent : undefined;
  const isThinking = 'isThinking' in message ? message.isThinking : false;

  // Skip rendering if message has no meaningful content
  const hasThinking =
    thinkingBlocks.length > 0 || (streamingThinking && streamingThinking.length > 0);
  const hasTextBefore = textBeforeTools.some((text) => text.trim().length > 0);
  const hasTextAfter = textAfterTools.some((text) => text.trim().length > 0);
  const hasTools = toolBlocks.length > 0;

  if (!hasThinking && !hasTextBefore && !hasTextAfter && !hasTools) {
    return null;
  }

  // IMPORTANT: For messages with tools AND text:
  // 1. Show thinking first (if any)
  // 2. Show tools next (compact, no bubble)
  // 3. Show text after as a response bubble
  // This matches the expected UX: thought process → actions → results

  return (
    <>
      {/* Thinking blocks (collapsed by default) */}
      {hasThinking && (
        <ThinkingBlock
          content={streamingThinking || thinkingBlocks.join('\n\n')}
          isStreaming={isThinking}
          defaultExpanded={false}
        />
      )}

      {/* Text before tools (if any) - rare but possible */}
      {hasTextBefore &&
        (() => {
          const avatar = isUser ? (
            <AgorAvatar>{userEmoji}</AgorAvatar>
          ) : (
            getAgentAvatar({ assistantEmoji, agentic_tool, isCallback, token })
          );

          return (
            <div style={{ margin: `${token.sizeUnit}px 0` }}>
              <Bubble
                placement={isUser ? 'end' : 'start'}
                avatar={
                  message.timestamp ? (
                    <Tooltip
                      title={() => formatTimestampWithRelative(message.timestamp, message.index)}
                      mouseEnterDelay={0.5}
                      fresh
                    >
                      <span>{avatar}</span>
                    </Tooltip>
                  ) : (
                    avatar
                  )
                }
                loading={isLoading}
                typing={shouldUseTyping ? { effect: 'typing', step: 5, interval: 20 } : false}
                content={
                  <CopyableContent
                    textContent={textBeforeTools.join('\n\n')}
                    copyTooltip="Copy message"
                  >
                    <div
                      style={{
                        wordWrap: 'break-word',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: token.sizeUnit,
                      }}
                    >
                      {textBeforeTools.map((text, idx) => {
                        // Use CollapsibleMarkdown for long text blocks (15+ lines)
                        const shouldTruncate = text.split('\n').length > 15;

                        return (
                          <div key={`text-${idx}-${text.substring(0, 20)}`}>
                            {shouldTruncate ? (
                              <CollapsibleMarkdown
                                maxLines={10}
                                defaultExpanded={isLatestMessage}
                                isStreaming={isStreaming}
                              >
                                {text}
                              </CollapsibleMarkdown>
                            ) : (
                              <MarkdownRenderer content={text} inline isStreaming={isStreaming} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </CopyableContent>
                }
                variant={isUser || isCallback ? 'filled' : 'outlined'}
                styles={{
                  content: {
                    backgroundColor: isCallback
                      ? token.colorWarningBg
                      : isUser
                        ? token.colorPrimaryBg
                        : undefined,
                    color: isUser ? '#fff' : undefined,
                  },
                }}
              />
            </div>
          );
        })()}

      {/* Tools (compact, no bubble) */}
      {hasTools && (
        <div
          style={{
            margin: `${token.sizeUnit * 1.5}px 0`,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {/* Index of last tool with a result — tools after this are potentially running */}
          {(() => {
            let lastResultIndex = -1;
            for (let i = toolBlocks.length - 1; i >= 0; i--) {
              if (toolBlocks[i].toolResult) {
                lastResultIndex = i;
                break;
              }
            }
            return toolBlocks.map(({ toolUse, toolResult }, toolIndex) => {
              const displayName = getToolDisplayName(toolUse.name, toolUse.input);
              const isAlwaysExpanded = ALWAYS_EXPANDED_TOOLS.has(toolUse.name);
              const hasImplicitResult = IMPLICIT_RESULT_TOOLS.has(toolUse.name);

              // A tool is potentially still running when no subsequent tool in
              // this message has a result AND this is the latest message.
              // This correctly handles concurrent tool calls (e.g. multiple
              // WebSearch calls) — they all show as "pending" simultaneously.
              const isPotentiallyRunning = toolIndex > lastResultIndex && isLatestMessage;

              const status = deriveToolStatus({
                hasResult: !!toolResult || hasImplicitResult,
                isError: !!toolResult?.is_error,
                isPotentiallyRunning,
                isTaskRunning,
              });
              const icon = renderToolStatusIcon(status);

              const bashNode =
                toolUse.name === 'Bash'
                  ? buildBashDescriptionNode(toolUse.input, token)
                  : undefined;

              return (
                <ToolBlock
                  key={toolUse.id}
                  icon={icon}
                  name={displayName}
                  description={bashNode ? undefined : getToolDescription(toolUse)}
                  descriptionNode={bashNode}
                  status={status}
                  expandedByDefault={isAlwaysExpanded}
                >
                  <ToolUseRenderer toolUse={toolUse} toolResult={toolResult} />
                </ToolBlock>
              );
            });
          })()}
        </div>
      )}

      {/* Response text after tools */}
      {hasTextAfter &&
        (() => {
          const avatar = getAgentAvatar({ assistantEmoji, agentic_tool, isCallback, token });

          return (
            <div style={{ margin: `${token.sizeUnit}px 0` }}>
              <Bubble
                placement="start"
                avatar={
                  message.timestamp ? (
                    <Tooltip
                      title={() => formatTimestampWithRelative(message.timestamp, message.index)}
                      mouseEnterDelay={0.5}
                      fresh
                    >
                      <span>{avatar}</span>
                    </Tooltip>
                  ) : (
                    avatar
                  )
                }
                loading={isLoading}
                typing={shouldUseTyping ? { effect: 'typing', step: 5, interval: 20 } : false}
                content={
                  <CopyableContent
                    textContent={textAfterTools.join('\n\n')}
                    copyTooltip="Copy message"
                  >
                    <div style={{ wordWrap: 'break-word' }}>
                      {(() => {
                        const combinedText = textAfterTools.join('\n\n');
                        const shouldTruncate = combinedText.split('\n').length > 15;

                        return shouldTruncate ? (
                          <CollapsibleMarkdown
                            maxLines={10}
                            defaultExpanded={isLatestMessage}
                            isStreaming={isStreaming}
                          >
                            {combinedText}
                          </CollapsibleMarkdown>
                        ) : (
                          <MarkdownRenderer
                            content={combinedText}
                            inline
                            isStreaming={isStreaming}
                          />
                        );
                      })()}
                    </div>
                  </CopyableContent>
                }
                variant={isCallback ? 'filled' : 'outlined'}
                styles={
                  isCallback
                    ? {
                        content: {
                          backgroundColor: token.colorWarningBg,
                        },
                      }
                    : undefined
                }
              />
            </div>
          );
        })()}
    </>
  );
};
