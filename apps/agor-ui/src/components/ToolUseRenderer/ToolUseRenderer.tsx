/**
 * ToolUseRenderer - Displays tool invocations and results
 *
 * Renders tool_use and tool_result content blocks with:
 * - Custom renderers for specific tools (via registry)
 * - Tool output/result
 * - Error states
 * - Collapsible input parameters
 *
 * Custom renderers are defined in ./renderers/index.ts
 *
 * Note: This component does NOT use ThoughtChain - parent components
 * (like AgentChain) are responsible for wrapping this in ThoughtChain items.
 */

import type { ContentBlock as CoreContentBlock } from '@agor/core/types';
import { theme } from 'antd';
import type React from 'react';
import { CollapsibleText } from '../CollapsibleText';
import { getToolRenderer } from './renderers';

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

type ContentBlock = { type: 'text'; text: string } | ToolUseBlock | ToolResultBlock;

interface ToolUseRendererProps {
  /**
   * Tool use block with invocation details
   */
  toolUse: ToolUseBlock;

  /**
   * Optional tool result block
   */
  toolResult?: ToolResultBlock;
}

export const ToolUseRenderer: React.FC<ToolUseRendererProps> = ({ toolUse, toolResult }) => {
  const { token } = theme.useToken();
  const { input, name } = toolUse;
  const isError = toolResult?.is_error;

  // Check for custom renderer
  const CustomRenderer = getToolRenderer(name);

  // If custom renderer exists, use it
  if (CustomRenderer) {
    return (
      <CustomRenderer
        toolUseId={toolUse.id}
        input={input}
        result={
          toolResult
            ? {
                content: toolResult.content,
                is_error: toolResult.is_error,
              }
            : undefined
        }
      />
    );
  }

  // Otherwise, use default generic renderer
  // Extract text content from tool result
  const getResultText = (): string => {
    if (!toolResult) return '';

    if (typeof toolResult.content === 'string') {
      return toolResult.content;
    }

    if (Array.isArray(toolResult.content)) {
      return toolResult.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('\n\n');
    }

    return '';
  };

  const resultText = getResultText();
  const hasContent = resultText.trim().length > 0;

  // Default generic content renderer (no ThoughtChain wrapper - that's handled by parent)
  return toolResult ? (
    <div>
      {/* Tool result */}
      <div
        style={{
          padding: token.sizeUnit,
          borderRadius: token.borderRadius,
          background: isError ? 'rgba(255, 77, 79, 0.05)' : 'rgba(82, 196, 26, 0.05)',
          border: `1px solid ${isError ? token.colorErrorBorder : token.colorSuccessBorder}`,
        }}
      >
        <CollapsibleText
          code
          preserveWhitespace
          style={{
            fontSize: 11,
            margin: 0,
            ...((!hasContent && {
              fontStyle: 'italic',
              color: token.colorTextSecondary,
            }) as React.CSSProperties),
          }}
        >
          {hasContent ? resultText : '(no output)'}
        </CollapsibleText>
      </div>

      {/* Tool input parameters (collapsible below result) */}
      <details style={{ marginTop: token.sizeUnit }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, color: token.colorTextSecondary }}>
          Show input parameters
        </summary>
        <pre
          style={{
            marginTop: token.sizeUnit / 2,
            background: token.colorBgLayout,
            padding: token.sizeUnit,
            borderRadius: token.borderRadius,
            fontFamily: 'Monaco, Menlo, Ubuntu Mono, Consolas, source-code-pro, monospace',
            fontSize: 10,
            overflowX: 'auto',
          }}
        >
          {JSON.stringify(input, null, 2)}
        </pre>
      </details>
    </div>
  ) : null;
};
