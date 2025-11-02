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
import { Avatar, theme } from 'antd';
import type React from 'react';
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

  const isUser = message.role === 'user';
  // Check if message is currently streaming
  const isStreaming = 'isStreaming' in message && message.isStreaming === true;

  // Determine loading vs typing state:
  // - loading: task is running but no streaming chunks yet (waiting for first token)
  // - typing: streaming has started (we have content)
  const hasContent =
    typeof message.content === 'string'
      ? message.content.trim().length > 0
      : Array.isArray(message.content) && message.content.length > 0;
  const isLoading = isTaskRunning && !hasContent && message.role === 'assistant';
  const shouldUseTyping = isStreaming && hasContent;

  // Get current user's emoji
  const currentUser = users.find(u => u.user_id === currentUserId);
  const userEmoji = currentUser?.emoji || '👤';

  // Skip rendering if message has no content
  if (!message.content || (typeof message.content === 'string' && message.content.trim() === '')) {
    return null;
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
      return {
        thinkingBlocks: [],
        textBeforeTools: [message.content],
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
          const text = (block as unknown as TextBlock).text;
          if (hasSeenTool) {
            textAfterTools.push(text);
          } else {
            textBeforeTools.push(text);
          }
        } else if (block.type === 'tool_use') {
          const toolUse = block as unknown as ToolUseBlock;
          toolUseMap.set(toolUse.id, toolUse);
          hasSeenTool = true;
        } else if (block.type === 'tool_result') {
          const toolResult = block as unknown as ToolResultBlock;
          toolResultMap.set(toolResult.tool_use_id, toolResult);
        }
      }

      // Second pass: match tool_use with tool_result
      for (const [id, toolUse] of toolUseMap.entries()) {
        toolBlocks.push({
          toolUse,
          toolResult: toolResultMap.get(id),
        });
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
                <Avatar style={{ backgroundColor: token.colorPrimaryBg, fontSize: '20px' }}>
                  {userEmoji}
                </Avatar>
              ) : agentic_tool ? (
                <ToolIcon tool={agentic_tool} size={32} />
              ) : (
                <Avatar icon={<RobotOutlined />} style={{ backgroundColor: token.colorSuccess }} />
              )
            }
            loading={isLoading}
            typing={shouldUseTyping ? { step: 5, interval: 20 } : false}
            content={
              <div style={{ wordWrap: 'break-word' }}>
                <MarkdownRenderer content={textBeforeTools} inline />
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
                <Avatar icon={<RobotOutlined />} style={{ backgroundColor: token.colorSuccess }} />
              )
            }
            loading={isLoading}
            typing={shouldUseTyping ? { step: 5, interval: 20 } : false}
            content={
              <div style={{ wordWrap: 'break-word' }}>
                <MarkdownRenderer content={textAfterTools} inline />
              </div>
            }
            variant="outlined"
          />
        </div>
      )}
    </>
  );
};
