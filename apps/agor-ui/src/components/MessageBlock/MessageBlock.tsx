/**
 * MessageBlock - Renders individual messages with support for structured content
 *
 * Handles:
 * - Text content (string or TextBlock)
 * - Tool use blocks
 * - Tool result blocks
 * - User vs Assistant styling
 */

import type { Message } from '@agor/core/types';
import { RobotOutlined, UserOutlined } from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Avatar, theme } from 'antd';
import type React from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
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
  content: string | ContentBlock[];
  is_error?: boolean;
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface MessageBlockProps {
  message: Message;
}

export const MessageBlock: React.FC<MessageBlockProps> = ({ message }) => {
  const { token } = theme.useToken();
  const isUser = message.role === 'user';

  // Skip rendering if message has no content
  if (!message.content || (typeof message.content === 'string' && message.content.trim() === '')) {
    return null;
  }

  // Parse content blocks from message, preserving order
  const getContentBlocks = (): {
    textBeforeTools: string[];
    toolBlocks: { toolUse: ToolUseBlock; toolResult?: ToolResultBlock }[];
    textAfterTools: string[];
  } => {
    const textBeforeTools: string[] = [];
    const textAfterTools: string[] = [];
    const toolBlocks: { toolUse: ToolUseBlock; toolResult?: ToolResultBlock }[] = [];

    // Handle string content
    if (typeof message.content === 'string') {
      return {
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
        if (block.type === 'text') {
          const text = (block as TextBlock).text;
          if (hasSeenTool) {
            textAfterTools.push(text);
          } else {
            textBeforeTools.push(text);
          }
        } else if (block.type === 'tool_use') {
          const toolUse = block as ToolUseBlock;
          toolUseMap.set(toolUse.id, toolUse);
          hasSeenTool = true;
        } else if (block.type === 'tool_result') {
          const toolResult = block as ToolResultBlock;
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

    return { textBeforeTools, toolBlocks, textAfterTools };
  };

  const { textBeforeTools, toolBlocks, textAfterTools } = getContentBlocks();

  // Skip rendering if message has no meaningful content
  const hasTextBefore = textBeforeTools.some(text => text.trim().length > 0);
  const hasTextAfter = textAfterTools.some(text => text.trim().length > 0);
  const hasTools = toolBlocks.length > 0;

  if (!hasTextBefore && !hasTextAfter && !hasTools) {
    return null;
  }

  // IMPORTANT: For messages with tools AND text:
  // 1. Show tools first (compact, no bubble)
  // 2. Show text after as a response bubble
  // This matches the expected UX: "Here's what I did" (tools) then "Here's the result" (response)

  return (
    <>
      {/* Thinking/text before tools (if any) - rare but possible */}
      {hasTextBefore && (
        <div style={{ margin: `${token.sizeUnit}px 0` }}>
          <Bubble
            placement={isUser ? 'end' : 'start'}
            avatar={
              isUser ? (
                <Avatar icon={<UserOutlined />} style={{ backgroundColor: token.colorPrimary }} />
              ) : (
                <Avatar icon={<RobotOutlined />} style={{ backgroundColor: token.colorSuccess }} />
              )
            }
            content={
              <div style={{ wordWrap: 'break-word' }}>
                {isUser ? (
                  textBeforeTools.filter(t => t.trim()).join('\n\n')
                ) : (
                  <MarkdownRenderer
                    content={textBeforeTools.filter(t => t.trim()).join('\n\n')}
                    inline
                  />
                )}
              </div>
            }
            variant={isUser ? 'filled' : 'outlined'}
            styles={{
              content: {
                backgroundColor: isUser ? token.colorPrimary : undefined,
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
              <Avatar icon={<RobotOutlined />} style={{ backgroundColor: token.colorSuccess }} />
            }
            content={
              <div style={{ wordWrap: 'break-word' }}>
                <MarkdownRenderer
                  content={textAfterTools.filter(t => t.trim()).join('\n\n')}
                  inline
                />
              </div>
            }
            variant="outlined"
          />
        </div>
      )}
    </>
  );
};
