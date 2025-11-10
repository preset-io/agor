/**
 * BashRenderer - Custom renderer for Bash tool blocks
 *
 * Displays Bash command execution with:
 * - Header showing "Bash (command)"
 * - Collapsible output with proper code block styling
 * - ANSI color support
 */

import { theme } from 'antd';
import type React from 'react';
import { shouldUseAnsiRendering } from '../../../utils/ansi';
import { CollapsibleAnsiText } from '../../CollapsibleText/CollapsibleAnsiText';
import { CollapsibleText } from '../../CollapsibleText';
import type { ToolRendererProps } from './index';

export const BashRenderer: React.FC<ToolRendererProps> = ({ input, result }) => {
  const { token } = theme.useToken();
  const command = input.command as string | undefined;
  const isError = result?.is_error;

  // Extract text content from result
  const getResultText = (): string => {
    if (!result) return '';

    if (typeof result.content === 'string') {
      return result.content;
    }

    if (Array.isArray(result.content)) {
      return result.content
        .filter((block): block is { type: 'text'; text: string } => {
          const b = block as { type: string; text?: string };
          return b.type === 'text';
        })
        .map(block => block.text)
        .join('\n\n');
    }

    return '';
  };

  const resultText = getResultText();
  const hasContent = resultText.trim().length > 0;
  const useAnsi = shouldUseAnsiRendering('Bash', resultText);

  return (
    <div>
      {/* Output with collapsible code block */}
      {result && (
        <>
          {useAnsi ? (
            <CollapsibleAnsiText
              style={{
                fontSize: token.fontSizeSM,
                margin: 0,
                ...((!hasContent && {
                  fontStyle: 'italic',
                  color: token.colorTextTertiary,
                }) as React.CSSProperties),
                ...(isError && {
                  color: token.colorError,
                }),
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
                ...((!hasContent && {
                  fontStyle: 'italic',
                  color: token.colorTextTertiary,
                }) as React.CSSProperties),
                ...(isError && {
                  color: token.colorError,
                }),
              }}
            >
              {hasContent ? resultText : '(no output)'}
            </CollapsibleText>
          )}
        </>
      )}

      {/* Tool input parameters (collapsible below result) */}
      {result && (
        <details style={{ marginTop: token.sizeUnit }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: token.fontSizeSM,
              color: token.colorTextSecondary,
            }}
          >
            Show input parameters
          </summary>
          <pre
            style={{
              marginTop: token.sizeUnit / 2,
              background: token.colorBgLayout,
              padding: token.sizeUnit,
              borderRadius: token.borderRadius,
              fontFamily: 'Monaco, Menlo, Ubuntu Mono, Consolas, source-code-pro, monospace',
              fontSize: token.fontSizeSM,
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
