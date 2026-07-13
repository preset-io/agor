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

import type { ToolResultContentBlock } from '@agor-live/client';
import { theme } from 'antd';
import type React from 'react';
import { shouldUseAnsiRendering } from '../../utils/ansi';
import { toolResultToDisplayText } from '../../utils/toolResultToDisplayText';
import { CollapsibleText } from '../CollapsibleText';
import { CollapsibleAnsiText } from '../CollapsibleText/CollapsibleAnsiText';
import { ThemedSyntaxHighlighter } from '../ThemedSyntaxHighlighter';
import { TranscriptProjectionNotice } from '../TranscriptProjectionNotice';
import { getToolRenderer } from './renderers';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolUseRendererProps {
  /**
   * Tool use block with invocation details
   */
  toolUse: ToolUseBlock;

  /**
   * Optional tool result block
   */
  toolResult?: ToolResultContentBlock;
}

export const ToolUseRenderer: React.FC<ToolUseRendererProps> = ({ toolUse, toolResult }) => {
  const { token } = theme.useToken();
  const { input, name } = toolUse;
  const isError = toolResult?.is_error;

  // Check for custom renderer
  const CustomRenderer = getToolRenderer(name);

  // Shared collapsible input parameters block
  const inputParamsBlock = (
    <details style={{ marginTop: token.sizeUnit }}>
      <summary
        style={{
          cursor: 'pointer',
          fontSize: 11,
          color: token.colorTextTertiary,
          userSelect: 'none',
        }}
      >
        Input parameters
      </summary>
      <ThemedSyntaxHighlighter
        language="json"
        PreTag="pre"
        customStyle={{
          marginTop: token.sizeUnit / 2,
          fontSize: 11,
          maxHeight: 300,
          overflow: 'auto',
        }}
      >
        {JSON.stringify(input, null, 2)}
      </ThemedSyntaxHighlighter>
    </details>
  );

  // If custom renderer exists, use it
  if (CustomRenderer) {
    return (
      <div>
        <TranscriptProjectionNotice projection={toolResult?.transcript_projection} />
        <CustomRenderer toolUseId={toolUse.id} input={input} result={toolResult} />
        {inputParamsBlock}
      </div>
    );
  }

  // Otherwise, use default generic renderer
  // Extract text content from tool result
  const getResultText = (): string => {
    if (!toolResult) return '';
    return toolResultToDisplayText(toolResult.content);
  };

  const resultText = getResultText();
  const hasContent = resultText.trim().length > 0;

  // Detect if we should use ANSI rendering for this tool output
  const useAnsi = shouldUseAnsiRendering(name, resultText);

  // Default generic content renderer (no ThoughtChain wrapper - that's handled by parent)
  return toolResult ? (
    <div>
      <TranscriptProjectionNotice projection={toolResult.transcript_projection} />
      {/* Tool result */}
      <div
        style={{
          padding: token.sizeUnit,
          borderRadius: token.borderRadius,
          ...(isError && {
            background: token.colorErrorBg,
            border: `1px solid ${token.colorErrorBorder}`,
          }),
        }}
      >
        {useAnsi ? (
          <CollapsibleAnsiText
            style={{
              fontSize: token.fontSizeSM,
              margin: 0,
              color: token.colorTextSecondary,
              ...((!hasContent && {
                fontStyle: 'italic',
              }) as React.CSSProperties),
            }}
          >
            {hasContent ? resultText : '(no output)'}
          </CollapsibleAnsiText>
        ) : (
          <CollapsibleText
            code
            preserveWhitespace
            style={{
              fontSize: token.fontSizeSM,
              margin: 0,
              color: token.colorTextSecondary,
              ...((!hasContent && {
                fontStyle: 'italic',
              }) as React.CSSProperties),
            }}
          >
            {hasContent ? resultText : '(no output)'}
          </CollapsibleText>
        )}
      </div>

      {/* Tool input parameters (collapsible below result) */}
      {inputParamsBlock}
    </div>
  ) : (
    // No result yet — still show input parameters so users can see what's running
    <div>{inputParamsBlock}</div>
  );
};
