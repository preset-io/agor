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
import { CollapsibleText } from '../../CollapsibleText';
import { CollapsibleAnsiText } from '../../CollapsibleText/CollapsibleAnsiText';
import { ThemedSyntaxHighlighter } from '../../ThemedSyntaxHighlighter';
import type { ToolRendererProps } from './index';

export const BashRenderer: React.FC<ToolRendererProps> = ({ input, result }) => {
  const { token } = theme.useToken();
  const command = input.command != null ? String(input.command) : undefined;
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
        .map((block) => block.text)
        .join('\n\n');
    }

    return '';
  };

  const resultText = getResultText();
  const hasContent = resultText.trim().length > 0;
  const useAnsi = shouldUseAnsiRendering('Bash', resultText);

  return (
    <div>
      {/* Full command as syntax-highlighted code block.
          Wraps long one-liners inside the ToolBlock so the whole command
          is visible without horizontal scroll on the conversation pane.
          `pre-wrap` preserves newlines (heredocs, && chains) while letting
          lines wrap; `break-all` ensures long URL-like tokens with no
          whitespace still break at container edges. */}
      {command && (
        <div
          style={{
            maxWidth: '100%',
            minWidth: 0,
            marginBottom: result ? token.sizeUnit : 0,
          }}
        >
          <ThemedSyntaxHighlighter
            language="bash"
            PreTag="pre"
            customStyle={{
              fontSize: token.fontSizeSM,
              padding: token.sizeUnit,
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              overflowWrap: 'anywhere',
              // Defeat the Prism theme's `overflow: auto` on the outer pre
              // so long lines wrap inside the container instead of scrolling.
              overflow: 'visible',
            }}
            // Prism themes set `white-space: pre` on the inner <code> element,
            // which overrides the outer <pre>'s pre-wrap. Override it here so
            // wrapping actually applies to the highlighted tokens.
            codeTagProps={{
              style: {
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                overflowWrap: 'anywhere',
              },
            }}
          >
            {command}
          </ThemedSyntaxHighlighter>
        </div>
      )}

      {/* Output with collapsible code block */}
      {result && (
        <div
          style={{
            background: token.colorBgLayout,
            borderRadius: token.borderRadius,
            padding: token.sizeUnit,
            overflow: 'auto',
          }}
        >
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
        </div>
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
