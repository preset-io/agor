/**
 * EditFilesRenderer — Custom renderer for Codex edit_files tool blocks.
 *
 * Maps Codex's { changes: [{ path, kind }] } to DiffBlock components.
 * Uses executor-enriched per-file diffs (diff.files) when available.
 * Falls back to a simple file path display when no diff data exists.
 */

import { Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { DiffBlock } from './DiffBlock';
import { extractErrorMessage, type ToolRendererProps } from './index';

interface FileChange {
  path: string;
  kind: 'add' | 'update' | 'delete';
}

const kindToOperationType = (kind: string): 'edit' | 'create' | 'delete' => {
  switch (kind) {
    case 'add':
      return 'create';
    case 'delete':
      return 'delete';
    default:
      return 'edit';
  }
};

const kindLabel = (kind: string): string => {
  switch (kind) {
    case 'add':
      return 'Create';
    case 'delete':
      return 'Delete';
    default:
      return 'Update';
  }
};

const normalizePathForMatch = (filePath: string): string => filePath.replace(/\\/g, '/');

const pathsMatch = (left: string, right: string): boolean => {
  const a = normalizePathForMatch(left);
  const b = normalizePathForMatch(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
};

export const EditFilesRenderer: React.FC<ToolRendererProps> = ({ input, result }) => {
  const { token } = theme.useToken();
  const changes = input.changes as FileChange[] | undefined;

  if (!changes || changes.length === 0) return null;

  const fileDiffs = result?.diff?.files;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {changes.map((change) => {
        const fileDiff = fileDiffs?.find((f) => pathsMatch(f.path, change.path));

        // If we have enrichment data, use the full DiffBlock
        if (fileDiff) {
          return (
            <DiffBlock
              key={change.path}
              filePath={fileDiff.path || change.path}
              operationType={kindToOperationType(fileDiff.kind || change.kind)}
              structuredPatch={fileDiff.structuredPatch}
              isError={result?.is_error}
              errorMessage={extractErrorMessage(result)}
              forceExpanded
            />
          );
        }

        // Fallback: show file path with operation label (no diff data available)
        return (
          <div
            key={change.path}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              padding: `${token.sizeUnit * 0.75}px ${token.sizeUnit}px`,
              borderRadius: token.borderRadius,
              background: token.colorBgLayout,
              border: `1px solid ${token.colorBorderSecondary}`,
              fontSize: token.fontSizeSM,
            }}
          >
            <Tooltip title={kindLabel(change.kind)}>
              <Typography.Text
                strong
                style={{
                  fontSize: token.fontSizeSM,
                  maxWidth: 96,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {kindLabel(change.kind)}
              </Typography.Text>
            </Tooltip>
            <Tooltip title={change.path}>
              <Typography.Text
                code
                style={{
                  fontSize: token.fontSizeSM - 1,
                  minWidth: 0,
                  flex: '1 1 auto',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {change.path}
              </Typography.Text>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
};
