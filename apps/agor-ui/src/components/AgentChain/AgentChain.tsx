/**
 * AgentChain - Collapsible visualization of agent reasoning and actions
 *
 * Groups sequential assistant messages containing:
 * - Internal thoughts (muted text blocks meant for agent reasoning)
 * - Tool uses (with results)
 *
 * Displays as:
 * - Collapsed (default): Summary with thought icon, counts, and stats
 * - Expanded: ThoughtChain showing sequential thoughts and tool uses
 *
 * Note: Regular assistant responses (text meant for user) are shown
 * as green message bubbles, NOT in AgentChain.
 */

import type { ContentBlock as CoreContentBlock, Message } from '@agor/core/types';
import {
  BulbOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DownOutlined,
  FileTextOutlined,
  RightOutlined,
} from '@ant-design/icons';
import type { ThoughtChainProps } from '@ant-design/x';
import { ThoughtChain } from '@ant-design/x';
import { Space, Spin, Tag, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
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

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface AgentChainProps {
  /**
   * Messages containing thoughts and/or tool uses
   */
  messages: Message[];
}

interface ChainItem {
  type: 'thought' | 'tool';
  content: string | { toolUse: ToolUseBlock; toolResult?: ToolResultBlock };
  message: Message;
}

export const AgentChain: React.FC<AgentChainProps> = ({ messages }) => {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);

  // Extract chain items (thoughts and tools) from messages
  const chainItems = useMemo(() => {
    const items: ChainItem[] = [];

    // First pass: collect ALL tool results from ALL messages (including user messages)
    const globalToolResultMap = new Map<string, ToolResultBlock>();
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'tool_result') {
            const toolResult = block as unknown as ToolResultBlock;
            globalToolResultMap.set(toolResult.tool_use_id, toolResult);
          }
        }
      }
    }

    // Second pass: process each message
    for (const message of messages) {
      if (typeof message.content === 'string') {
        // Simple text thought
        if (message.content.trim()) {
          items.push({
            type: 'thought',
            content: message.content,
            message,
          });
        }
        continue;
      }

      if (!Array.isArray(message.content)) continue;

      // Special handling: Tool result messages (user role with tool_result blocks)
      // Extract text content and show as thoughts
      if (message.role === 'user') {
        const toolResults = message.content.filter(b => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const block of toolResults) {
            const toolResult = block as unknown as ToolResultBlock;
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
              items.push({
                type: 'thought',
                content: resultText,
                message,
              });
            }
          }
          continue; // Skip normal processing for tool result messages
        }
      }

      const toolUseMap = new Map<string, ToolUseBlock>();
      const textBlocksBeforeTools: string[] = [];
      const textBlocksAfterTools: string[] = [];

      let hasSeenTool = false;

      // Collect blocks from this message
      for (const block of message.content) {
        if (block.type === 'text') {
          const text = (block as unknown as TextBlock).text.trim();
          if (text) {
            if (hasSeenTool) {
              textBlocksAfterTools.push(text);
            } else {
              textBlocksBeforeTools.push(text);
            }
          }
        } else if (block.type === 'tool_use') {
          const toolUse = block as unknown as ToolUseBlock;
          toolUseMap.set(toolUse.id, toolUse);
          hasSeenTool = true;
        }
        // Skip tool_result here - we collected them globally above
      }

      // Add thoughts (text blocks BEFORE tools)
      for (const text of textBlocksBeforeTools) {
        items.push({
          type: 'thought',
          content: text,
          message,
        });
      }

      // Add tool uses with globally matched results
      for (const [id, toolUse] of toolUseMap.entries()) {
        items.push({
          type: 'tool',
          content: {
            toolUse,
            toolResult: globalToolResultMap.get(id), // Look up from global map
          },
          message,
        });
      }

      // Add text blocks AFTER tools as thoughts (will be styled differently below)
      for (const text of textBlocksAfterTools) {
        items.push({
          type: 'thought',
          content: text,
          message,
        });
      }
    }

    return items;
  }, [messages]);

  // Calculate stats
  const stats = useMemo(() => {
    let thoughtCount = 0;
    let toolCount = 0;
    let successCount = 0;
    let errorCount = 0;
    const toolNames = new Map<string, number>();
    const filesAffected = new Set<string>();

    for (const item of chainItems) {
      if (item.type === 'thought') {
        thoughtCount++;
      } else {
        toolCount++;
        const { toolUse, toolResult } = item.content as {
          toolUse: ToolUseBlock;
          toolResult?: ToolResultBlock;
        };

        // Count tool names
        toolNames.set(toolUse.name, (toolNames.get(toolUse.name) || 0) + 1);

        // Track files
        if (['Edit', 'Read', 'Write'].includes(toolUse.name) && toolUse.input.file_path) {
          filesAffected.add(toolUse.input.file_path as string);
        }

        // Count results
        if (toolResult) {
          if (toolResult.is_error) {
            errorCount++;
          } else {
            successCount++;
          }
        }
      }
    }

    return {
      thoughtCount,
      toolCount,
      successCount,
      errorCount,
      toolNames,
      filesAffected: Array.from(filesAffected).sort(),
    };
  }, [chainItems]);

  // Generate smart description for tool
  const getToolDescription = (toolUse: ToolUseBlock): string | null => {
    const { name, input } = toolUse;

    if (typeof input.description === 'string') {
      return input.description;
    }

    switch (name) {
      case 'Read':
      case 'Write':
      case 'Edit':
        if (input.file_path) {
          const path = String(input.file_path);
          return path
            .replace(/^\/Users\/[^/]+\/code\/[^/]+\//, '')
            .replace(/^\/Users\/[^/]+\//, '~/');
        }
        return null;

      case 'Grep':
        return input.pattern ? `Search: ${input.pattern}` : null;

      case 'Glob':
        return input.pattern ? `Find files: ${input.pattern}` : null;

      default:
        return null;
    }
  };

  // Build ThoughtChain items
  const thoughtChainItems: ThoughtChainProps['items'] = chainItems.map((item, _index) => {
    if (item.type === 'thought') {
      const thoughtContent = item.content as string;

      return {
        title: 'Thinking',
        // No status - thoughts are neutral, not success/error
        ...(thoughtContent.trim() && {
          content: (
            <div
              style={{
                padding: token.sizeUnit,
                borderRadius: token.borderRadius,
                background: token.colorBgElevated,
              }}
            >
              <MarkdownRenderer
                content={thoughtContent}
                inline
                style={{ color: token.colorTextTertiary }}
              />
            </div>
          ),
        }),
      };
    } else {
      // Tool use
      const { toolUse, toolResult } = item.content as {
        toolUse: ToolUseBlock;
        toolResult?: ToolResultBlock;
      };
      const isError = toolResult?.is_error;
      const description = getToolDescription(toolUse);

      // Build tooltip content with tool input parameters
      const tooltipContent = (
        <pre
          key={toolUse.id}
          style={{
            margin: 0,
            fontSize: 11,
            maxWidth: 400,
            maxHeight: 300,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(toolUse.input, null, 2)}
        </pre>
      );

      // Determine status and icon
      // Don't use 'success' or 'pending' status to avoid colored backgrounds from ThoughtChain
      // Only use 'error' status for actual errors
      const status = isError ? 'error' : undefined;
      const icon = !toolResult ? (
        <span key="loading" style={{ opacity: 1 }}>
          <Spin size="small" />
        </span>
      ) : isError ? (
        <CloseCircleOutlined key="error" style={{ fontSize: 14, color: token.colorError }} />
      ) : (
        <CheckCircleOutlined
          key="success"
          style={{ fontSize: 14, color: token.colorTextSecondary }}
        />
      );

      // Build additional details line (e.g., command for Bash)
      let detailsLine: string | null = null;
      if (toolUse.name === 'Bash' && toolUse.input.command) {
        detailsLine = String(toolUse.input.command);
      } else if (['Read', 'Write', 'Edit'].includes(toolUse.name) && toolUse.input.file_path) {
        // For file operations, show full path as details
        detailsLine = String(toolUse.input.file_path);
      } else if (toolUse.name === 'Grep' && toolUse.input.pattern) {
        detailsLine = `Pattern: ${toolUse.input.pattern}`;
      } else if (toolUse.name === 'Glob' && toolUse.input.pattern) {
        detailsLine = `Pattern: ${toolUse.input.pattern}`;
      }

      return {
        title: (
          <Tooltip title={tooltipContent} placement="right" mouseEnterDelay={0.3}>
            <span style={{ cursor: 'help' }}>
              <strong>{toolUse.name}</strong>
              {description && <>: {description}</>}
            </span>
          </Tooltip>
        ),
        description: detailsLine ? (
          <Typography.Text code type="secondary" ellipsis>
            {detailsLine}
          </Typography.Text>
        ) : undefined,
        status,
        icon,
        // Only include content if we have a tool result
        ...(toolResult && {
          content: <ToolUseRenderer toolUse={toolUse} toolResult={toolResult} />,
        }),
      };
    }
  });

  // Summary section
  const summaryDescription = (
    <Space direction="vertical" size={token.sizeUnit / 2} style={{ marginTop: token.sizeUnit / 2 }}>
      {/* Tool name tags */}
      {stats.toolNames.size > 0 && (
        <Space size={token.sizeUnit} wrap>
          {Array.from(stats.toolNames.entries()).map(([name, count]) => (
            <Tag
              key={name}
              icon={<ToolIcon tool={name} size={12} />}
              style={{ fontSize: 11, margin: 0 }}
            >
              {name} × {count}
            </Tag>
          ))}
        </Space>
      )}

      {/* Result stats */}
      {(stats.successCount > 0 || stats.errorCount > 0) && (
        <Space size={token.sizeUnit}>
          {stats.successCount > 0 && (
            <Tag icon={<CheckCircleOutlined />} color="success" style={{ fontSize: 11, margin: 0 }}>
              {stats.successCount} success
            </Tag>
          )}
          {stats.errorCount > 0 && (
            <Tag icon={<CloseCircleOutlined />} color="error" style={{ fontSize: 11, margin: 0 }}>
              {stats.errorCount} error
            </Tag>
          )}
        </Space>
      )}

      {/* Files affected */}
      {stats.filesAffected.length > 0 && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            <FileTextOutlined /> {stats.filesAffected.length}{' '}
            {stats.filesAffected.length === 1 ? 'file' : 'files'} affected
          </Typography.Text>
        </div>
      )}
    </Space>
  );

  const _totalCount = stats.thoughtCount + stats.toolCount;
  const hasErrors = stats.errorCount > 0;

  return (
    <div style={{ margin: `${token.sizeUnit * 1.5}px 0` }}>
      {/* Collapsed summary - clickable */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: token.sizeUnit * 1.5,
          borderRadius: token.borderRadius,
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorder}`,
          cursor: 'pointer',
          transition: 'all 0.2s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = token.colorPrimaryBorder;
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = token.colorBorder;
        }}
      >
        <Space direction="vertical" size={token.sizeUnit} style={{ width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: token.sizeUnit }}>
            {/* Expand/collapse icon */}
            {expanded ? (
              <DownOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
            ) : (
              <RightOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
            )}

            {/* Status icon */}
            {hasErrors ? (
              <CloseCircleOutlined style={{ color: token.colorError, fontSize: 16 }} />
            ) : (
              <CheckCircleOutlined style={{ color: token.colorTextSecondary, fontSize: 16 }} />
            )}

            {/* Summary text */}
            <Typography.Text strong>
              <BulbOutlined /> {stats.thoughtCount > 0 && `${stats.thoughtCount} thoughts`}
              {stats.thoughtCount > 0 && stats.toolCount > 0 && ', '}
              {stats.toolCount > 0 && `${stats.toolCount} tools`}
            </Typography.Text>
          </div>

          {/* Only show details when collapsed */}
          {!expanded && summaryDescription}
        </Space>
      </div>

      {/* Expanded chain */}
      {expanded && (
        <div style={{ paddingLeft: token.sizeUnit * 8, marginTop: token.sizeUnit }}>
          <ThoughtChain items={thoughtChainItems} />
        </div>
      )}
    </div>
  );
};
