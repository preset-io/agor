/**
 * AgentChain - Collapsible visualization of agent reasoning and actions
 *
 * Groups sequential assistant messages containing:
 * - Internal thoughts (muted text blocks meant for agent reasoning)
 * - Tool uses (with results)
 *
 * Displays as:
 * - Collapsed (default): Tool count or latest activity
 * - Expanded: ToolBlock items showing sequential thoughts and tool uses
 *
 * Note: Regular assistant responses (text meant for user) are shown
 * as green message bubbles, NOT in AgentChain.
 */

import type {
  ContentBlock as CoreContentBlock,
  DiffEnrichment,
  Message,
  ToolExecutionState,
  TranscriptTruncation,
} from '@agor-live/client';
import { BulbOutlined } from '@ant-design/icons';
import { ConfigProvider, Typography, theme } from 'antd';
import React, { useEffect, useMemo, useState } from 'react';
import { getToolDisplayName } from '../../utils/toolDisplayName';
import { toolResultToDisplayText } from '../../utils/toolResultToDisplayText';
import { CollapsibleText } from '../CollapsibleText';
import {
  buildBashDescriptionNode,
  deriveToolStatus,
  IMPLICIT_RESULT_TOOLS,
  renderToolStatusIcon,
  shouldExpandToolByDefault,
  ToolBlock,
} from '../ToolBlock';
import { ToolDisclosureHeader } from '../ToolBlock/ToolBlock';
import { ToolUseRenderer } from '../ToolUseRenderer';
import { TranscriptTruncationNotice } from '../ToolUseRenderer/TranscriptTruncationNotice';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  transcript_truncation?: TranscriptTruncation;
  type: 'tool_result';
  tool_use_id: string;
  content: string | CoreContentBlock[];
  is_error?: boolean;
  diff?: DiffEnrichment;
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
  /** Remove desktop transcript indentation at phone widths. */
  compact?: boolean;
  revealRequested?: boolean;
  latestActivity?: ToolExecutionState;
  hasFollowingResponse?: boolean;
}

interface ChainItem {
  type: 'thought' | 'tool';
  content: string | { toolUse: ToolUseBlock; toolResult?: ToolResultBlock };
  message: Message;
  transcript_truncation?: TranscriptTruncation;
}

export const AgentChain = React.memo<AgentChainProps>(
  ({
    messages,
    isTaskRunning = false,
    isLatest,
    compact = false,
    revealRequested = false,
    latestActivity,
    hasFollowingResponse = false,
  }) => {
    const { token } = theme.useToken();
    const [expanded, setExpanded] = useState(revealRequested);
    useEffect(() => {
      if (revealRequested) setExpanded(true);
    }, [revealRequested]);

    // Extract chain items (thoughts and tools) from messages
    const chainItems = useMemo(() => {
      // Return early if no messages
      if (!messages || messages.length === 0) {
        return [];
      }

      const items: ChainItem[] = [];

      // First pass: collect ALL tool results from ALL messages (including user messages)
      const globalToolResultMap = new Map<string, ToolResultBlock>();
      const renderedToolUseIds = new Set<string>();
      for (const message of messages) {
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'tool_use' && message.role !== 'user') {
              renderedToolUseIds.add((block as unknown as ToolUseBlock).id);
            }
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
              const truncation = toolResult.transcript_truncation;
              const isProjected = Object.keys(truncation ?? {}).length > 0;
              // Paired projected results belong to ToolUseRenderer: a second
              // text-only thought could hide the notice behind a different
              // toggle, or duplicate it. Task results live in a separate chain
              // from their call, so their thought must own the disclosure.
              if (isProjected && renderedToolUseIds.has(toolResult.tool_use_id)) continue;

              const resultText = toolResultToDisplayText(toolResult.content);
              if (resultText.trim() || isProjected) {
                items.push({
                  type: 'thought',
                  content: resultText,
                  message,
                  transcript_truncation: truncation,
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
          if (block.type === 'text' || block.type === 'thinking') {
            // Normalized blocks use text; Claude SDK thinking blocks use thinking.
            // ContentBlock fields are unknown and may be absent in partial payloads.
            const text = (
              typeof block.text === 'string'
                ? block.text
                : block.type === 'thinking' && typeof block.thinking === 'string'
                  ? block.thinking
                  : ''
            ).trim();
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

    const stats = useMemo(() => {
      let toolCount = 0;
      let errorCount = 0;
      for (const item of chainItems) {
        if (item.type === 'tool' && typeof item.content !== 'string') {
          toolCount++;
          if (item.content.toolResult?.is_error) errorCount++;
        }
      }
      return { toolCount, errorCount };
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
          <React.Fragment key={`thought-${index}`}>
            {/* Keep omission visible even while the result text is collapsed. */}
            <TranscriptTruncationNotice truncations={[item.transcript_truncation]} />
            <ToolBlock
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
          </React.Fragment>
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

    const hasErrors = stats.errorCount > 0;
    const latestToolItem = [...chainItems].reverse().find((item) => item.type === 'tool');
    const latestToolName =
      latestToolItem && typeof latestToolItem.content !== 'string'
        ? latestToolItem.content.toolUse.name
        : undefined;

    // Early return if no items (prevents empty bordered boxes)
    if (chainItems.length === 0) {
      return null;
    }

    return (
      <div style={{ margin: `${token.sizeUnit * 1.5}px 0` }}>
        {/* Collapsed summary - clickable */}
        <ToolDisclosureHeader
          label={`${
            isTaskRunning && isLatest && latestActivity
              ? `${latestActivity.status === 'executing' ? 'Running' : 'Latest'}: ${latestActivity.toolName}`
              : isTaskRunning && isLatest && latestToolName
                ? `${latestToolItem && typeof latestToolItem.content !== 'string' && !latestToolItem.content.toolResult ? 'Running' : 'Latest'}: ${latestToolName}`
                : stats.toolCount
                  ? `${stats.toolCount} tool ${stats.toolCount === 1 ? 'call' : 'calls'}`
                  : 'Reasoning'
          }${hasErrors ? ' · Errors' : ''}`}
          expanded={expanded}
          executing={
            !!(
              isTaskRunning &&
              isLatest &&
              (!hasFollowingResponse ||
                latestActivity?.status === 'executing' ||
                (!latestActivity &&
                  latestToolItem &&
                  typeof latestToolItem.content !== 'string' &&
                  !latestToolItem.content.toolResult &&
                  !IMPLICIT_RESULT_TOOLS.has(latestToolItem.content.toolUse.name)))
            )
          }
          onClick={() => setExpanded(!expanded)}
        />

        {/* Expanded chain */}
        {expanded && (
          <ConfigProvider
            theme={{
              token: {
                fontSize: token.fontSizeSM,
                fontSizeSM: token.fontSizeSM,
                colorText: token.colorTextSecondary,
              },
            }}
          >
            <div
              style={{
                fontSize: token.fontSizeSM,
                color: token.colorTextSecondary,
                paddingLeft: compact ? 0 : token.sizeUnit * 8,
                marginTop: token.sizeUnit,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {chainItems.map(renderChainItem)}
            </div>
          </ConfigProvider>
        )}
      </div>
    );
  }
);

AgentChain.displayName = 'AgentChain';
