/**
 * Shared tool description helpers for tool call headers.
 *
 * Used by AgentChain and MessageBlock to produce consistent
 * description nodes for specific tools (e.g. Bash).
 */

import type { GlobalToken } from 'antd';
import { Typography } from 'antd';
import type React from 'react';

/**
 * Build a React node for the Bash tool header description.
 *
 * Shows the description text (if present) followed by the command
 * in a code tag, ellipsized only when it exceeds the available row width.
 *
 * Returns undefined when there is no command to display.
 */
export function buildBashDescriptionNode(
  input: Record<string, unknown>,
  token: GlobalToken
): React.ReactNode | undefined {
  if (!input.command) return undefined;

  const bashDesc = input.description ? String(input.description) : null;
  const cmd = String(input.command);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 4,
        minWidth: 0,
        flex: 1,
        overflow: 'hidden',
      }}
    >
      {bashDesc && (
        <Typography.Text
          type="secondary"
          ellipsis
          style={{
            fontSize: token.fontSizeSM,
            fontWeight: 'normal',
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {bashDesc}
        </Typography.Text>
      )}
      <Typography.Text code ellipsis style={{ fontSize: token.fontSizeSM - 1, minWidth: 0 }}>
        {cmd}
      </Typography.Text>
    </span>
  );
}
