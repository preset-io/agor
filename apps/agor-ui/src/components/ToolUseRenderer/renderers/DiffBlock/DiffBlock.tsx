/**
 * DiffBlock — Renders a syntax-highlighted diff view for file edits.
 *
 * Two rendering tiers:
 * 1. Rich: With structuredPatch from executor (line numbers + context)
 * 2. Fallback: Client-side diffLines from old/new strings (no line numbers)
 *
 * Collapsed by default for large diffs (>10 lines), expanded for small ones.
 */

import { CopyOutlined, DownOutlined, RightOutlined } from '@ant-design/icons';
import { Tooltip, Typography, theme } from 'antd';
import { createPatch } from 'diff';
import type React from 'react';
import { useState } from 'react';
import { copyToClipboard } from '@/utils/clipboard';
import { useThemedMessage } from '@/utils/message';
import { isDarkTheme } from '@/utils/theme';
import { type DiffLine, type StructuredPatchHunk, useDiff, type WordSegment } from './useDiff';

/** Lines of diff output before we collapse by default */
const COLLAPSE_THRESHOLD = 10;
/** Lines shown in truncated view for very large diffs */
const TRUNCATE_THRESHOLD = 50;
const TRUNCATE_SHOW_LINES = 20;

export interface DiffBlockProps {
  filePath: string;
  operationType: 'edit' | 'create' | 'delete';
  oldContent?: string;
  newContent?: string;
  structuredPatch?: StructuredPatchHunk[];
  isError?: boolean;
  errorMessage?: string;
  /** Override the default expand/collapse heuristic */
  forceExpanded?: boolean;
}

/** Shorten an absolute file path for display */
const shortenPath = (filePath: string): string => {
  // Strip common worktree prefixes
  const markers = ['/worktrees/', '/home/', '/Users/'];
  for (const marker of markers) {
    const idx = filePath.indexOf(marker);
    if (idx !== -1) {
      // Find the repo/project root after the marker
      const afterMarker = filePath.slice(idx + marker.length);
      const parts = afterMarker.split('/');
      // Skip user/worktree name segments, show from project root
      if (parts.length > 3) {
        return parts.slice(parts.length > 5 ? -4 : 2).join('/');
      }
      return afterMarker;
    }
  }
  // Fallback: last 4 segments
  const parts = filePath.split('/');
  return parts.length > 4 ? parts.slice(-4).join('/') : filePath;
};

const operationLabel = (type: string) => {
  switch (type) {
    case 'create':
      return 'Create';
    case 'delete':
      return 'Delete';
    default:
      return 'Update';
  }
};

export const DiffBlock: React.FC<DiffBlockProps> = ({
  filePath,
  operationType,
  oldContent,
  newContent,
  structuredPatch,
  isError,
  errorMessage,
  forceExpanded,
}) => {
  const { token } = theme.useToken();
  const { showSuccess } = useThemedMessage();
  const isDark = isDarkTheme(token);
  const diff = useDiff(oldContent, newContent, structuredPatch);

  const defaultExpanded =
    forceExpanded ?? (diff.totalLines <= COLLAPSE_THRESHOLD && diff.totalLines > 0);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showAll, setShowAll] = useState(false);

  // Color tokens for diff
  const addBg = isDark ? 'rgba(46, 160, 67, 0.15)' : 'rgba(46, 160, 67, 0.1)';
  const removeBg = isDark ? 'rgba(218, 54, 51, 0.15)' : 'rgba(218, 54, 51, 0.1)';
  const addColor = isDark ? '#3fb950' : '#1a7f37';
  const removeColor = isDark ? '#f85149' : '#cf222e';
  // Brighter backgrounds for word-level highlights (the "inner diff")
  const addWordBg = isDark ? 'rgba(46, 160, 67, 0.4)' : 'rgba(46, 160, 67, 0.3)';
  const removeWordBg = isDark ? 'rgba(218, 54, 51, 0.4)' : 'rgba(218, 54, 51, 0.3)';
  const contextColor = token.colorTextTertiary;
  const lineNumColor = token.colorTextQuaternary;
  const separatorColor = token.colorBorderSecondary;

  if (isError) {
    return (
      <div
        style={{
          padding: token.sizeUnit,
          borderRadius: token.borderRadius,
          background: 'rgba(255, 77, 79, 0.05)',
          border: `1px solid ${token.colorErrorBorder}`,
        }}
      >
        <Typography.Text type="danger" style={{ fontSize: token.fontSizeSM }}>
          {errorMessage || 'Edit failed'}
        </Typography.Text>
      </div>
    );
  }

  if (diff.totalLines === 0) return null;

  const handleCopyDiff = async () => {
    let diffText: string;
    if (oldContent !== undefined && newContent !== undefined) {
      diffText = createPatch(filePath, oldContent, newContent);
    } else if (newContent !== undefined) {
      diffText = createPatch(filePath, '', newContent);
    } else {
      // Reconstruct from lines
      diffText = diff.lines
        .map((l) => {
          if (l.type === 'add') return `+${l.content}`;
          if (l.type === 'remove') return `-${l.content}`;
          return ` ${l.content}`;
        })
        .join('\n');
    }
    await copyToClipboard(diffText);
    showSuccess('Diff copied');
  };

  const needsTruncation = diff.totalLines > TRUNCATE_THRESHOLD && !showAll;
  const visibleLines = needsTruncation ? diff.lines.slice(0, TRUNCATE_SHOW_LINES) : diff.lines;

  const renderWordSegments = (segments: WordSegment[], highlightBg: string) => {
    // Merge adjacent unchanged segments to minimize DOM nodes, then render
    const merged: { text: string; changed: boolean }[] = [];
    for (const seg of segments) {
      const isChanged = seg.type === 'changed';
      const last = merged[merged.length - 1];
      if (last && last.changed === isChanged) {
        last.text += seg.text;
      } else {
        merged.push({ text: seg.text, changed: isChanged });
      }
    }
    return merged.map((seg) =>
      seg.changed ? (
        <span key={seg.text} style={{ background: highlightBg, borderRadius: 2 }}>
          {seg.text}
        </span>
      ) : (
        seg.text
      )
    );
  };

  const renderLine = (line: DiffLine, index: number) => {
    const isSeparator = line.type === 'context' && line.content === '...';

    if (isSeparator) {
      return (
        <div
          key={index}
          style={{
            padding: '2px 8px',
            color: separatorColor,
            fontSize: token.fontSizeSM,
            fontStyle: 'italic',
            borderTop: `1px dashed ${separatorColor}`,
            borderBottom: `1px dashed ${separatorColor}`,
          }}
        >
          ...
        </div>
      );
    }

    const bg = line.type === 'add' ? addBg : line.type === 'remove' ? removeBg : undefined;
    const color =
      line.type === 'add' ? addColor : line.type === 'remove' ? removeColor : contextColor;
    const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
    const lineNum = line.type === 'remove' ? line.oldLineNumber : line.newLineNumber;

    return (
      <div
        key={index}
        style={{
          display: 'flex',
          background: bg,
          fontFamily: 'Monaco, Menlo, Ubuntu Mono, Consolas, source-code-pro, monospace',
          fontSize: token.fontSizeSM,
          lineHeight: '20px',
          minHeight: 20,
        }}
      >
        {/* Line number gutter */}
        {diff.hasLineNumbers && (
          <span
            style={{
              width: 48,
              minWidth: 48,
              textAlign: 'right',
              paddingRight: 8,
              color: lineNumColor,
              userSelect: 'none',
              flexShrink: 0,
            }}
          >
            {lineNum ?? ''}
          </span>
        )}
        {/* Prefix (+/-/space) */}
        <span
          style={{
            width: 16,
            minWidth: 16,
            textAlign: 'center',
            color,
            userSelect: 'none',
            flexShrink: 0,
            fontWeight: line.type !== 'context' ? 600 : undefined,
          }}
        >
          {prefix}
        </span>
        {/* Content */}
        <span
          style={{
            color: line.type === 'context' ? contextColor : color,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            flex: 1,
            paddingRight: 8,
          }}
        >
          {line.wordSegments
            ? renderWordSegments(line.wordSegments, line.type === 'add' ? addWordBg : removeWordBg)
            : line.content || ' '}
        </span>
      </div>
    );
  };

  return (
    <div>
      {/* Header — always visible, clickable to expand/collapse */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: `${token.sizeUnit * 0.75}px ${token.sizeUnit}px`,
          cursor: 'pointer',
          borderRadius: expanded
            ? `${token.borderRadius}px ${token.borderRadius}px 0 0`
            : token.borderRadius,
          background: token.colorBgLayout,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderBottom: expanded ? 'none' : undefined,
          fontSize: token.fontSizeSM,
          userSelect: 'none',
        }}
      >
        {expanded ? (
          <DownOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} />
        ) : (
          <RightOutlined style={{ fontSize: 10, color: token.colorTextSecondary }} />
        )}

        <Typography.Text strong style={{ fontSize: token.fontSizeSM }}>
          {operationLabel(operationType)}
        </Typography.Text>

        <Tooltip title={filePath}>
          <Typography.Text
            code
            style={{
              fontSize: token.fontSizeSM - 1,
              maxWidth: 300,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {shortenPath(filePath)}
          </Typography.Text>
        </Tooltip>

        <span style={{ flex: 1 }} />

        {/* Stats */}
        {diff.stats.additions > 0 && (
          <span style={{ color: addColor, fontWeight: 600, fontSize: 11 }}>
            +{diff.stats.additions}
          </span>
        )}
        {diff.stats.deletions > 0 && (
          <span style={{ color: removeColor, fontWeight: 600, fontSize: 11 }}>
            -{diff.stats.deletions}
          </span>
        )}
      </div>

      {/* Diff body */}
      {expanded && (
        <div
          style={{
            border: `1px solid ${token.colorBorderSecondary}`,
            borderTop: 'none',
            borderRadius: `0 0 ${token.borderRadius}px ${token.borderRadius}px`,
            overflow: 'hidden',
          }}
        >
          <div style={{ overflowX: 'auto' }}>{visibleLines.map(renderLine)}</div>

          {/* Truncation notice */}
          {needsTruncation && (
            <div
              onClick={(e) => {
                e.stopPropagation();
                setShowAll(true);
              }}
              style={{
                padding: `${token.sizeUnit * 0.75}px ${token.sizeUnit}px`,
                textAlign: 'center',
                cursor: 'pointer',
                color: token.colorPrimary,
                fontSize: token.fontSizeSM,
                borderTop: `1px dashed ${separatorColor}`,
                background: token.colorBgLayout,
              }}
            >
              Show {diff.totalLines - TRUNCATE_SHOW_LINES} more lines
            </div>
          )}

          {/* Actions bar */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              padding: `3px ${token.sizeUnit}px`,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgLayout,
            }}
          >
            <Tooltip title="Copy diff">
              <CopyOutlined
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyDiff();
                }}
                style={{
                  fontSize: 12,
                  color: token.colorTextTertiary,
                  cursor: 'pointer',
                  padding: 4,
                }}
              />
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
};
