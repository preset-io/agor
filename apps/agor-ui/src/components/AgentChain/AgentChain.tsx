/**
 * AgentChain - Collapsible visualization of agent reasoning and actions
 *
 * Groups sequential assistant messages containing:
 * - Internal thoughts (muted text blocks meant for agent reasoning)
 * - Tool uses (with results)
 *
 * Displays as:
 * - Collapsed (default): Summary with thought icon, counts, and stats
 * - Expanded: ToolBlock items showing sequential thoughts and tool uses
 *
 * Note: Regular assistant responses (text meant for user) are shown
 * as green message bubbles, NOT in AgentChain.
 */

import type { ContentBlock as CoreContentBlock, DiffEnrichment, Message } from '@agor-live/client';
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
import { Popover, Space, Typography, theme } from 'antd';
import React, { useMemo, useState } from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import { getToolDisplayName } from '../../utils/toolDisplayName';
import { toolResultToDisplayText } from '../../utils/toolResultToDisplayText';
import { CollapsibleText } from '../CollapsibleText';
import { Tag } from '../Tag';
import {
  buildBashDescriptionNode,
  deriveToolStatus,
  IMPLICIT_RESULT_TOOLS,
  renderToolStatusIcon,
  shouldExpandToolByDefault,
  ToolBlock,
} from '../ToolBlock';
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

interface AgentChainProps {
  /**
   * Messages containing thoughts and/or tool uses
   */
  messages: Message[];
  /** Whether the parent task is still running (controls spinner vs stale for pending tools) */
  isTaskRunning?: boolean;
  /** Whether this is the latest (most recent) agent chain block — used for pending/stale status detection */
  isLatest?: boolean;
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
    // Codex tools
    case 'edit_files':
      return <EditOutlined {...iconProps} />;
    // MCP tools
    case 'ListMcpResourcesTool':
    case 'ReadMcpResourceTool':
      return <FileSearchOutlined {...iconProps} />;
    // Fallback for unknown tools
    default:
      return <ToolOutlined {...iconProps} />;
  }
}

export const AgentChain = React.memo<AgentChainProps>(
  ({ messages, isTaskRunning = false, isLatest }) => {
    const { token } = theme.useToken();
    const [expanded, setExpanded] = useState(true);

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
              const resultText = toolResultToDisplayText(toolResult.content);

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

          // Count tool names (use display name for MCP proxy tools)
          const displayName = getToolDisplayName(toolUse.name, toolUse.input);
          toolNames.set(displayName, (toolNames.get(displayName) || 0) + 1);

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
        case 'NotebookEdit':
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

        case 'ToolSearch':
          return input.query ? String(input.query) : null;

        case 'WebSearch':
          return input.query ? String(input.query) : null;

        case 'WebFetch':
          return input.url ? String(input.url) : null;

        case 'Agent':
          return input.description ? String(input.description) : null;

        case 'Skill':
        case 'SlashCommand':
          return input.skill ? String(input.skill) : input.name ? String(input.name) : null;

        case 'Task':
          if (input.prompt) {
            const firstLine = String(input.prompt).trim().split('\n')[0];
            return firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
          }
          return null;

        case 'TodoWrite': {
          const todos = Array.isArray(input.todos) ? input.todos : [];
          if (todos.length === 0) return null;
          const done = todos.filter((t: { status?: string }) => t.status === 'completed').length;
          const inProg = todos.filter(
            (t: { status?: string }) => t.status === 'in_progress'
          ).length;
          const parts = [`${done}/${todos.length} done`];
          if (inProg > 0) parts.push(`${inProg} in progress`);
          return parts.join(', ');
        }

        case 'edit_files': {
          const changes = Array.isArray(input.changes) ? input.changes : [];
          if (changes.length === 0) return null;
          if (changes.length === 1) {
            const c = changes[0] as { path?: string; kind?: string };
            const shortPath = c.path
              ? String(c.path)
                  .replace(/^\/Users\/[^/]+\/code\/[^/]+\//, '')
                  .replace(/^\/Users\/[^/]+\//, '~/')
              : '';
            return `${c.kind || 'update'} ${shortPath}`;
          }
          return `${changes.length} files`;
        }

        default:
          return null;
      }
    };

    // Resolve the display name for a tool (handles MCP proxy tools)
    const resolveDisplayName = (toolUse: ToolUseBlock): string => {
      return getToolDisplayName(toolUse.name, toolUse.input);
    };

    // Precompute index of the last tool item that has a result.
    // Tools after this index have no subsequent completed tool, so they
    // are potentially still running (handles concurrent tool calls).
    const lastResultToolIndex = useMemo(() => {
      for (let i = chainItems.length - 1; i >= 0; i--) {
        if (chainItems[i].type === 'tool') {
          const { toolResult } = chainItems[i].content as {
            toolResult?: ToolResultBlock;
          };
          if (toolResult) return i;
        }
      }
      return -1;
    }, [chainItems]);

    // Build tool block items for rendering
    const renderChainItem = (item: ChainItem, index: number) => {
      if (item.type === 'thought') {
        const thoughtContent = item.content as string;
        const oneLine = thoughtContent.replace(/\s+/g, ' ').trim();

        return (
          <ToolBlock
            key={`thought-${index}`}
            icon={<BulbOutlined style={{ fontSize: 14 }} />}
            name="Thinking"
            description={oneLine || undefined}
            status="success"
          >
            {thoughtContent.trim() && (
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
            )}
          </ToolBlock>
        );
      }

      // Tool use
      const { toolUse, toolResult } = item.content as {
        toolUse: ToolUseBlock;
        toolResult?: ToolResultBlock;
      };
      const isError = toolResult?.is_error;
      const displayName = resolveDisplayName(toolUse);
      const hasImplicitResult = IMPLICIT_RESULT_TOOLS.has(toolUse.name);

      // Derive status and icon via shared helper.
      // A tool is potentially still running when no subsequent tool in
      // this chain has a result AND this is the active (latest) chain.
      const isPotentiallyRunning = index > lastResultToolIndex && isLatest !== false;
      const status = deriveToolStatus({
        hasResult: !!toolResult || hasImplicitResult,
        isError: !!isError,
        isPotentiallyRunning,
        isTaskRunning,
      });
      const icon = renderToolStatusIcon(status);

      // Description — key context for the tool call
      let description = getToolDescription(toolUse);
      let descriptionNode: React.ReactNode | undefined;

      if (toolUse.name === 'Bash') {
        const bashNode = buildBashDescriptionNode(toolUse.input, token);
        if (bashNode) {
          descriptionNode = bashNode;
          description = null;
        }
      } else if ((toolUse.name === 'Grep' || toolUse.name === 'Glob') && toolUse.input.pattern) {
        descriptionNode = (
          <Typography.Text code style={{ fontSize: token.fontSizeSM - 1 }}>
            {String(toolUse.input.pattern)}
          </Typography.Text>
        );
        description = null;
      }

      return (
        <ToolBlock
          key={toolUse.id}
          icon={icon}
          name={displayName}
          description={description ?? undefined}
          descriptionNode={descriptionNode}
          status={status}
          expandedByDefault={shouldExpandToolByDefault(toolUse.name)}
        >
          <ToolUseRenderer toolUse={toolUse} toolResult={toolResult} />
        </ToolBlock>
      );
    };

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
          <div
            style={{
              paddingLeft: token.sizeUnit * 8,
              marginTop: token.sizeUnit,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {chainItems.map(renderChainItem)}
          </div>
        )}
      </div>
    );
  }
);

AgentChain.displayName = 'AgentChain';
