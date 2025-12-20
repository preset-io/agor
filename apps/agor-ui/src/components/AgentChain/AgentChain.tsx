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
  BranchesOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  CheckSquareOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  DownOutlined,
  EditOutlined,
  FileAddOutlined,
  FileOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  RightOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import type { ThoughtChainProps } from '@ant-design/x';
import { ThoughtChain } from '@ant-design/x';
import { Popover, Space, Spin, Tooltip, Typography, theme } from 'antd';
import React, { useMemo, useState } from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import { CollapsibleText } from '../CollapsibleText';
import { CopyableContent } from '../CopyableContent';
import { Tag } from '../Tag';
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

/**
 * Get the appropriate Ant Design icon for a tool name
 */
function getToolIcon(toolName: string): React.ReactElement {
  const iconProps = { style: { fontSize: 12 } };

  switch (toolName) {
    case 'Read':
      return <FileOutlined {...iconProps} />;
    case 'Write':
      return <FileAddOutlined {...iconProps} />;
    case 'Edit':
      return <EditOutlined {...iconProps} />;
    case 'Bash':
      return <CodeOutlined {...iconProps} />;
    case 'Grep':
      return <SearchOutlined {...iconProps} />;
    case 'Glob':
      return <FolderOpenOutlined {...iconProps} />;
    case 'Task':
      return <BranchesOutlined {...iconProps} />;
    case 'TodoWrite':
      return <CheckSquareOutlined {...iconProps} />;
    case 'WebFetch':
      return <GlobalOutlined {...iconProps} />;
    case 'WebSearch':
      return <SearchOutlined {...iconProps} />;
    case 'NotebookEdit':
      return <FileTextOutlined {...iconProps} />;
    case 'Skill':
    case 'SlashCommand':
      return <ThunderboltOutlined {...iconProps} />;
    // MCP tools
    case 'ListMcpResourcesTool':
    case 'ReadMcpResourceTool':
      return <FileSearchOutlined {...iconProps} />;
    // Fallback for unknown tools
    default:
      return <ToolOutlined {...iconProps} />;
  }
}

export const AgentChain = React.memo<AgentChainProps>(({ messages }) => {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);

  // Extract chain items (thoughts and tools) from messages
  const chainItems = useMemo(() => {
    // Return early if no messages
    if (!messages || messages.length === 0) {
      return [];
    }

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
        const toolResults = message.content.filter((b) => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const block of toolResults) {
            const toolResult = block as unknown as ToolResultBlock;
            let resultText = '';

            if (typeof toolResult.content === 'string') {
              resultText = toolResult.content;
            } else if (Array.isArray(toolResult.content)) {
              resultText = toolResult.content
                .filter((b) => b.type === 'text')
                .map((b) => (b as unknown as { text: string }).text)
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
            <CollapsibleText
              maxLines={8}
              preserveWhitespace
              style={{
                fontSize: token.fontSizeSM,
                margin: 0,
                color: token.colorTextTertiary,
              }}
            >
              {thoughtContent}
            </CollapsibleText>
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

      // Build title with inline command/pattern for Bash, Grep, Glob
      let titleContent: React.ReactNode;
      if (toolUse.name === 'Bash' && toolUse.input.command) {
        // For Bash, just show the tool name (command will be shown as description)
        titleContent = (
          <span>
            <strong>Bash</strong>
          </span>
        );
      } else if (toolUse.name === 'Grep' && toolUse.input.pattern) {
        titleContent = (
          <span style={{ cursor: 'help' }}>
            <strong>Grep: </strong>
            <Typography.Text code>{String(toolUse.input.pattern)}</Typography.Text>
          </span>
        );
      } else if (toolUse.name === 'Glob' && toolUse.input.pattern) {
        titleContent = (
          <span style={{ cursor: 'help' }}>
            <strong>Glob: </strong>
            <Typography.Text code>{String(toolUse.input.pattern)}</Typography.Text>
          </span>
        );
      } else {
        // Default: tool name with optional description
        titleContent = (
          <span style={{ cursor: 'help' }}>
            <strong>{toolUse.name}</strong>
            {description && <>: {description}</>}
          </span>
        );
      }

      // Additional details line for file operations and Bash commands
      let detailsLine: React.ReactNode | null = null;
      if (['Read', 'Write', 'Edit'].includes(toolUse.name) && toolUse.input.file_path) {
        detailsLine = (
          <Typography.Text code type="secondary" ellipsis>
            {String(toolUse.input.file_path)}
          </Typography.Text>
        );
      } else if (toolUse.name === 'Bash' && toolUse.input.command) {
        // Show Bash command as a code block (not ellipsis, allows wrapping)
        const commandText = String(toolUse.input.command);
        detailsLine = (
          <CopyableContent
            textContent={commandText}
            copyTooltip="Copy command"
            copyButtonOffset={{ top: token.sizeXXS, right: token.sizeXXS }}
          >
            <pre
              style={{
                margin: 0,
                padding: `${token.sizeXXS}px ${token.sizeXS}px`,
                background: token.colorBgLayout,
                borderRadius: token.borderRadiusSM,
                fontSize: token.fontSizeSM,
                fontFamily: 'Monaco, Menlo, Ubuntu Mono, Consolas, source-code-pro, monospace',
                color: token.colorTextSecondary,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxWidth: '100%',
              }}
            >
              {commandText}
            </pre>
          </CopyableContent>
        );
      }

      // Build tooltip content - for Bash, include metadata like timeout, background, description
      let finalTooltipContent: React.ReactNode = tooltipContent;
      if (toolUse.name === 'Bash') {
        const bashMetadata: string[] = [];
        if (toolUse.input.description) {
          bashMetadata.push(`Description: ${toolUse.input.description}`);
        }
        if (toolUse.input.timeout) {
          bashMetadata.push(`Timeout: ${toolUse.input.timeout}ms`);
        }
        if (toolUse.input.run_in_background) {
          bashMetadata.push('Running in background');
        }

        if (bashMetadata.length > 0) {
          finalTooltipContent = (
            <div>
              <div style={{ marginBottom: 8, fontSize: 12, color: token.colorTextSecondary }}>
                {bashMetadata.map((meta) => (
                  <div key={meta}>{meta}</div>
                ))}
              </div>
              {tooltipContent}
            </div>
          );
        }
      }

      return {
        title: (
          <Tooltip title={finalTooltipContent} placement="right" mouseEnterDelay={0.3}>
            {titleContent}
          </Tooltip>
        ),
        description: detailsLine,
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
    <Space size={token.sizeUnit} wrap style={{ marginTop: token.sizeUnit / 2 }}>
      {/* Tool name tags */}
      {stats.toolNames.size > 0 &&
        Array.from(stats.toolNames.entries()).map(([name, count]) => (
          <Tag key={name} icon={getToolIcon(name)} style={{ fontSize: 11, margin: 0 }}>
            {name} × {count}
          </Tag>
        ))}

      {/* Result stats */}
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

      {/* Files affected */}
      {stats.filesAffected.length > 0 && (
        <Popover
          content={
            <div style={{ maxWidth: 450 }}>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                {stats.filesAffected.map((file) => (
                  <div
                    key={file}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '4px 0',
                      fontSize: token.fontSizeSM,
                      color: token.colorTextSecondary,
                      fontFamily: 'monospace',
                      wordBreak: 'break-all',
                    }}
                  >
                    <span style={{ flex: 1 }}>{file}</span>
                    <CopyOutlined
                      style={{
                        fontSize: 10,
                        color: token.colorTextTertiary,
                        cursor: 'pointer',
                        opacity: 0.5,
                        transition: 'opacity 0.2s',
                        flexShrink: 0,
                      }}
                      onClick={() => copyToClipboard(file)}
                      title="Copy to clipboard"
                    />
                  </div>
                ))}
              </div>
            </div>
          }
          title={`${stats.filesAffected.length} ${stats.filesAffected.length === 1 ? 'file' : 'files'} affected`}
          trigger="hover"
        >
          <Typography.Text type="secondary" style={{ fontSize: 11, cursor: 'pointer' }}>
            <FileTextOutlined /> {stats.filesAffected.length}{' '}
            {stats.filesAffected.length === 1 ? 'file' : 'files'} affected
          </Typography.Text>
        </Popover>
      )}
    </Space>
  );

  const _totalCount = stats.thoughtCount + stats.toolCount;
  const hasErrors = stats.errorCount > 0;

  // Early return if no items (prevents empty bordered boxes)
  if (chainItems.length === 0) {
    return null;
  }

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
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = token.colorPrimaryBorder;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = token.colorBorder;
        }}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', gap: token.sizeUnit, flexWrap: 'wrap' }}
        >
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

          {/* Only show details when collapsed */}
          {!expanded && summaryDescription}
        </div>
      </div>

      {/* Expanded chain */}
      {expanded && (
        <div style={{ paddingLeft: token.sizeUnit * 8, marginTop: token.sizeUnit }}>
          <ThoughtChain items={thoughtChainItems} />
        </div>
      )}
    </div>
  );
});

AgentChain.displayName = 'AgentChain';
