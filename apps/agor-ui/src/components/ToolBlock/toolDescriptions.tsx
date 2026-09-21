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
import type { DiffStats } from '../ToolUseRenderer/renderers/DiffBlock';

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

/**
 * A quiet `+N -N`. Uses DiffBlock's ASCII glyphs so a change reads the same
 * on a collapsed row as it does in the diff header it expands to.
 */
export function buildDiffStatNode(stats: DiffStats, token: GlobalToken): React.ReactNode {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0, fontSize: token.fontSizeSM }}>
      {stats.additions > 0 && <span style={{ color: token.colorSuccess }}>+{stats.additions}</span>}
      {stats.deletions > 0 && <span style={{ color: token.colorError }}>-{stats.deletions}</span>}
    </span>
  );
}
