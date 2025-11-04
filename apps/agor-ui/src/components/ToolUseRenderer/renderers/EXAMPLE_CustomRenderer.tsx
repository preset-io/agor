/**
 * EXAMPLE: Custom Tool Renderer with CollapsibleText
 *
 * This is an example showing how to create a custom renderer for a tool
 * that displays long text output using the CollapsibleText component.
 *
 * To use this pattern:
 * 1. Copy this file and rename it for your tool (e.g., BashRenderer.tsx)
 * 2. Update the component name and logic
 * 3. Register it in ./index.ts
 */

import { theme } from 'antd';
import type React from 'react';
import { CollapsibleText } from '../../CollapsibleText';
import { TEXT_TRUNCATION } from '../../../constants/ui';
import type { ToolRendererProps } from './index';

/**
 * Example Custom Renderer
 *
 * Shows how to use CollapsibleText for long tool outputs
 */
export const ExampleCustomRenderer: React.FC<ToolRendererProps> = ({
  toolUseId,
  input,
  result,
}) => {
  const { token } = theme.useToken();

  // Extract text content from result
  const getResultText = (): string => {
    if (!result) return '';

    if (typeof result.content === 'string') {
      return result.content;
    }

    if (Array.isArray(result.content)) {
      return result.content
        .filter((block: any): block is { type: 'text'; text: string } => block.type === 'text')
        .map(block => block.text)
        .join('\n\n');
    }

    return '';
  };

  const resultText = getResultText();
  const isError = result?.is_error;

  return (
    <div>
      {/* Your custom header/metadata here */}
      <div style={{ marginBottom: token.sizeUnit, color: token.colorTextSecondary, fontSize: 12 }}>
        Custom tool output:
      </div>

      {/* Tool output with CollapsibleText */}
      <div
        style={{
          padding: token.sizeUnit * 1.5,
          borderRadius: token.borderRadius,
          background: isError ? 'rgba(255, 77, 79, 0.05)' : token.colorBgContainer,
          border: `1px solid ${isError ? token.colorErrorBorder : token.colorBorder}`,
        }}
      >
        {resultText ? (
          <CollapsibleText
            maxLines={TEXT_TRUNCATION.DEFAULT_LINES}
            preserveWhitespace
            code
            style={{
              fontSize: 12,
              margin: 0,
            }}
          >
            {resultText}
          </CollapsibleText>
        ) : (
          <div style={{ fontStyle: 'italic', color: token.colorTextSecondary }}>
            (no output)
          </div>
        )}
      </div>

      {/* Optional: Show input parameters */}
      {input && Object.keys(input).length > 0 && (
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
              fontFamily: 'monospace',
              fontSize: 10,
              overflowX: 'auto',
            }}
          >
            {JSON.stringify(input, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
};

/**
 * To register this renderer:
 *
 * In ./index.ts:
 * import { ExampleCustomRenderer } from './EXAMPLE_CustomRenderer';
 * TOOL_RENDERERS.set('YourToolName', ExampleCustomRenderer);
 */
