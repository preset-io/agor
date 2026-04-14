/**
 * Shared tool description helpers for tool call headers.
 *
 * Used by AgentChain and MessageBlock to produce consistent
 * description nodes for specific tools (e.g. Bash).
 */

import type { GlobalToken } from 'antd';
import { Typography } from 'antd';
import type React from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';

/**
 * Build a React node for the Bash tool header description.
 *
 * Shows the description text (if present) followed by the command
 * in a code tag, truncated to BASH_COMMAND_PREVIEW_CHARS.
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
  const maxLen = TEXT_TRUNCATION.BASH_COMMAND_PREVIEW_CHARS;
  const truncatedCmd = cmd.length > maxLen ? `${cmd.slice(0, maxLen)}…` : cmd;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 4,
        minWidth: 0,
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
      <Typography.Text code ellipsis style={{ fontSize: token.fontSizeSM - 1 }}>
        {truncatedCmd}
      </Typography.Text>
    </span>
  );
}
