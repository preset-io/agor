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
  type Message,
  type PermissionRequestContent,
  PermissionScope,
  PermissionStatus,
  type User,
} from '@agor/core/types';
import { RobotOutlined } from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Space, Spin, Typography, theme } from 'antd';

const { Text } = Typography;

import type React from 'react';
import { AgorAvatar } from '../AgorAvatar';
import { CollapsibleMarkdown } from '../CollapsibleText/CollapsibleMarkdown';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { PermissionRequestBlock } from '../PermissionRequestBlock';
import { ThinkingBlock } from '../ThinkingBlock';
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

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingContentBlock;

interface MessageBlockProps {
  message:
    | Message
    | (Message & { isStreaming?: boolean; thinkingContent?: string; isThinking?: boolean });
  users?: User[];
  currentUserId?: string;
  isTaskRunning?: boolean; // Whether the task is running (for loading state)
  agentic_tool?: string; // Agentic tool name for showing tool icon
  sessionId?: string | null;
  taskId?: string;
  isFirstPendingPermission?: boolean; // For sequencing permission requests
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
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
  const hasTextBlock = message.content.some(block => block.type === 'text');
  const hasOnlyTextBlocks = message.content.every(
    block => block.type === 'text' || block.type === 'thinking'
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
  const hasToolResult = message.content.some(block => block.type === 'tool_result');

  // User messages with tool_results that aren't in agent chains are likely Task results
  return hasToolResult;
}

export const MessageBlock: React.FC<MessageBlockProps> = ({
  message,
  users = [],
  currentUserId,
  isTaskRunning = false,
  agentic_tool,
  sessionId,
  taskId,
  isFirstPendingPermission = false,
  onPermissionDecision,
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
          onApprove={
            canInteract && onPermissionDecision && sessionId && taskId
              ? (messageId, scope) => {
                  onPermissionDecision(sessionId, content.request_id, taskId, true, scope);
                }
              : undefined
          }
          onDeny={
            canInteract && onPermissionDecision && sessionId && taskId
              ? messageId => {
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

  // Check if this is a Task tool prompt or result (agent-generated, but has user role)
  const isTaskPrompt = isTaskToolPrompt(message);
  const isTaskResult = isTaskToolResult(message);
  const isSystem = message.role === 'system';

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
  const currentUser = users.find(u => u.user_id === currentUserId);
  const userEmoji = currentUser?.emoji || '👤';

  // Skip rendering if message has no content
  if (!message.content || (typeof message.content === 'string' && message.content.trim() === '')) {
    return null;
  }

  // Special handling for system messages (compaction, etc.)
  if (isSystem && Array.isArray(message.content)) {
    const systemStatusBlock = message.content.find(b => b.type === 'system_status');
    if (systemStatusBlock && 'status' in systemStatusBlock) {
      const status = systemStatusBlock.status;

      if (status === 'compacting') {
        return (
          <div style={{ margin: `${token.sizeUnit}px 0` }}>
            <Bubble
              placement="start"
              avatar={
                agentic_tool ? (
                  <ToolIcon tool={agentic_tool} size={32} />
                ) : (
                  <AgorAvatar
                    icon={<RobotOutlined />}
                    style={{ backgroundColor: token.colorBgContainer }}
                  />
                )
              }
              content={
                <Space>
                  <Spin size="small" />
                  <Text type="secondary">Compacting conversation context...</Text>
                </Space>
              }
              variant="outlined"
            />
          </div>
        );
      }
    }
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
            let resultText = '';
            if (typeof toolResult.content === 'string') {
              resultText = toolResult.content;
            } else if (Array.isArray(toolResult.content)) {
              resultText = toolResult.content
                .filter(b => b.type === 'text')
                .map(b => (b as unknown as { text: string }).text)
                .join('\n');
            }

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
  const hasTextBefore = textBeforeTools.some(text => text.trim().length > 0);
  const hasTextAfter = textAfterTools.some(text => text.trim().length > 0);
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
      {hasTextBefore && (
        <div style={{ margin: `${token.sizeUnit}px 0` }}>
          <Bubble
            placement={isUser ? 'end' : 'start'}
            avatar={
              isUser ? (
                <AgorAvatar>{userEmoji}</AgorAvatar>
              ) : agentic_tool ? (
                <ToolIcon tool={agentic_tool} size={32} />
              ) : (
                <AgorAvatar
                  icon={<RobotOutlined />}
                  style={{ backgroundColor: token.colorBgContainer }}
                />
              )
            }
            loading={isLoading}
            typing={shouldUseTyping ? { step: 5, interval: 20 } : false}
            content={
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
                        <CollapsibleMarkdown maxLines={10}>{text}</CollapsibleMarkdown>
                      ) : (
                        <MarkdownRenderer content={text} inline />
                      )}
                    </div>
                  );
                })}
              </div>
            }
            variant={isUser ? 'filled' : 'outlined'}
            styles={{
              content: {
                backgroundColor: isUser ? token.colorPrimaryBg : undefined,
                color: isUser ? '#fff' : undefined,
              },
            }}
          />
        </div>
      )}

      {/* Tools (compact, no bubble) */}
      {hasTools && (
        <div style={{ margin: `${token.sizeUnit * 1.5}px 0` }}>
          {toolBlocks.map(({ toolUse, toolResult }) => (
            <ToolUseRenderer key={toolUse.id} toolUse={toolUse} toolResult={toolResult} />
          ))}
        </div>
      )}

      {/* Response text after tools */}
      {hasTextAfter && (
        <div style={{ margin: `${token.sizeUnit}px 0` }}>
          <Bubble
            placement="start"
            avatar={
              agentic_tool ? (
                <ToolIcon tool={agentic_tool} size={32} />
              ) : (
                <AgorAvatar
                  icon={<RobotOutlined />}
                  style={{ backgroundColor: token.colorBgContainer }}
                />
              )
            }
            loading={isLoading}
            typing={shouldUseTyping ? { step: 5, interval: 20 } : false}
            content={
              <div style={{ wordWrap: 'break-word' }}>
                {(() => {
                  const combinedText = textAfterTools.join('\n\n');
                  const shouldTruncate = combinedText.split('\n').length > 15;

                  return shouldTruncate ? (
                    <CollapsibleMarkdown maxLines={10}>{combinedText}</CollapsibleMarkdown>
                  ) : (
                    <MarkdownRenderer content={combinedText} inline />
                  );
                })()}
              </div>
            }
            variant="outlined"
          />
        </div>
      )}
    </>
  );
};
