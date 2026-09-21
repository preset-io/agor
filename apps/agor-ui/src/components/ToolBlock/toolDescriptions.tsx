/**
 * Shared tool description helpers for tool call headers.
 *
 * Used by AgentChain and MessageBlock to produce consistent
 * description nodes for specific tools (e.g. Bash).
 */

import type { DiffEnrichment } from '@agor-live/client';
import type { GlobalToken } from 'antd';
import { Typography } from 'antd';
import type React from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';
import { diffEnrichmentStats } from '../ToolUseRenderer/renderers/DiffBlock';

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

/** Tools whose collapsed row is worth a change-size stat. */
const DIFF_STAT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'edit_files']);

/**
 * Build the collapsed compact row description for an edit-type tool: its usual
 * text followed by a quiet `+N −N`, so the size of a change is readable without
 * expanding it. Returns undefined when the tool does not edit files or its
 * result carries no diff, leaving the caller's plain description in place.
 *
 * Detailed already opens these tools onto the full diff, so it does not use this.
 */
export function buildDiffStatDescriptionNode(
  toolName: string,
  description: string | null | undefined,
  diff: DiffEnrichment | undefined,
  token: GlobalToken
): React.ReactNode | undefined {
  if (!DIFF_STAT_TOOLS.has(toolName)) return undefined;

  const stats = diffEnrichmentStats(diff);
  if (!stats) return undefined;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      {description && (
        <Typography.Text
          type="secondary"
          ellipsis
          style={{ fontSize: token.fontSizeSM, fontWeight: 'normal', flexShrink: 1, minWidth: 0 }}
        >
          {description}
        </Typography.Text>
      )}
      <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0, fontSize: token.fontSizeSM }}>
        {stats.additions > 0 && (
          <span style={{ color: token.colorSuccess }}>+{stats.additions}</span>
        )}
        {stats.deletions > 0 && <span style={{ color: token.colorError }}>−{stats.deletions}</span>}
      </span>
    </span>
  );
}
