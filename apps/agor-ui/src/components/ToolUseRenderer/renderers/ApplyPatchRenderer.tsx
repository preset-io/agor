/**
 * ApplyPatchRenderer — Custom renderer for Codex's apply_patch tool.
 *
 * Codex emits apply_patch as a custom tool whose input is already a patch-like
 * diff. It does not go through the executor-side edit_files snapshot enrichment,
 * so render the patch directly instead of treating the whole patch text as a
 * new file/addition.
 */

import type { StructuredPatchHunk } from '@agor-live/client';
import { Typography, theme } from 'antd';
import type React from 'react';
import { CollapsibleText } from '../../CollapsibleText';
import { DiffBlock } from './DiffBlock';
import {
  type FileChangeKind,
  fileChangeKindLabel,
  fileChangeKindToOperationType,
} from './fileChangePresentation';
import { extractErrorMessage, type ToolRendererProps } from './index';

export interface ParsedApplyPatchFile {
  path: string;
  kind: FileChangeKind;
  moveTo?: string;
  structuredPatch: StructuredPatchHunk[];
}

interface MutableHunk {
  oldStart: number;
  newStart: number;
  explicitOldLines?: number;
  explicitNewLines?: number;
  lines: string[];
}

const FILE_HEADER_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_TO_RE = /^\*\*\* Move to: (.+)$/;
const HUNK_LINE_NUMBERS_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/;

const headerKindToFileKind = (kind: string): FileChangeKind => {
  switch (kind) {
    case 'Add':
      return 'add';
    case 'Delete':
      return 'delete';
    default:
      return 'update';
  }
};

const fileKey = (file: ParsedApplyPatchFile): string => {
  const hunkSignature = file.structuredPatch
    .map((hunk) => `${hunk.oldStart}:${hunk.newStart}:${hunk.lines.length}`)
    .join('|');
  return `${file.kind}:${file.path}:${file.moveTo ?? ''}:${hunkSignature}`;
};

const displayPath = (file: ParsedApplyPatchFile): string =>
  file.moveTo ? `${file.path} → ${file.moveTo}` : file.path;

function finalizeHunk(hunk: MutableHunk | undefined): StructuredPatchHunk | undefined {
  if (!hunk || hunk.lines.length === 0) return undefined;

  const computedOldLines = hunk.lines.filter((line) => !line.startsWith('+')).length;
  const computedNewLines = hunk.lines.filter((line) => !line.startsWith('-')).length;

  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.explicitOldLines ?? computedOldLines,
    newStart: hunk.newStart,
    newLines: hunk.explicitNewLines ?? computedNewLines,
    lines: hunk.lines,
  };
}

function defaultHunkForKind(kind: FileChangeKind): MutableHunk {
  if (kind === 'add') {
    return { oldStart: 0, newStart: 1, explicitOldLines: 0, lines: [] };
  }
  if (kind === 'delete') {
    return { oldStart: 1, newStart: 0, explicitNewLines: 0, lines: [] };
  }
  return { oldStart: 1, newStart: 1, lines: [] };
}

function hunkForHeader(line: string): MutableHunk {
  const lineNumbers = line.match(HUNK_LINE_NUMBERS_RE);
  return {
    oldStart: lineNumbers?.[1] ? Number(lineNumbers[1]) : 1,
    explicitOldLines: lineNumbers?.[2] ? Number(lineNumbers[2]) : undefined,
    newStart: lineNumbers?.[3] ? Number(lineNumbers[3]) : 1,
    explicitNewLines: lineNumbers?.[4] ? Number(lineNumbers[4]) : undefined,
    lines: [],
  };
}

function extractPatchText(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;

  const record = input as Record<string, unknown>;
  for (const key of ['patch', 'input', 'content', 'text']) {
    if (typeof record[key] === 'string') return record[key];
  }

  return undefined;
}

export function parseApplyPatch(patchText: string): ParsedApplyPatchFile[] {
  const files: ParsedApplyPatchFile[] = [];
  let current:
    | {
        path: string;
        kind: FileChangeKind;
        moveTo?: string;
        hunks: StructuredPatchHunk[];
      }
    | undefined;
  let currentHunk: MutableHunk | undefined;

  const flushHunk = () => {
    const hunk = finalizeHunk(currentHunk);
    if (hunk && current) current.hunks.push(hunk);
    currentHunk = undefined;
  };

  const flushFile = () => {
    flushHunk();
    if (current) {
      files.push({
        path: current.path,
        kind: current.kind,
        moveTo: current.moveTo,
        structuredPatch: current.hunks,
      });
    }
    current = undefined;
  };

  for (const line of patchText.split('\n')) {
    const fileHeader = line.match(FILE_HEADER_RE);
    if (fileHeader) {
      flushFile();
      current = {
        kind: headerKindToFileKind(fileHeader[1]),
        path: fileHeader[2].trim(),
        hunks: [],
      };
      currentHunk = undefined;
      continue;
    }

    if (!current) continue;

    const moveTo = line.match(MOVE_TO_RE);
    if (moveTo) {
      current.moveTo = moveTo[1].trim();
      continue;
    }

    if (line === '*** End Patch' || line.startsWith('*** ')) {
      flushFile();
      continue;
    }

    if (line.startsWith('@@')) {
      flushHunk();
      currentHunk = hunkForHeader(line);
      continue;
    }

    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      currentHunk ??= defaultHunkForKind(current.kind);
      currentHunk.lines.push(line);
    }
  }

  flushFile();
  return files;
}

const ApplyPatchFileRow: React.FC<{ file: ParsedApplyPatchFile }> = ({ file }) => {
  const { token } = theme.useToken();
  const isMove = Boolean(file.moveTo);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `${token.sizeUnit * 0.75}px ${token.sizeUnit}px`,
        borderRadius: token.borderRadius,
        background: token.colorBgLayout,
        border: `1px solid ${token.colorBorderSecondary}`,
        fontSize: token.fontSizeSM,
      }}
    >
      <Typography.Text strong style={{ fontSize: token.fontSizeSM }}>
        {isMove ? 'Move' : fileChangeKindLabel(file.kind)}
      </Typography.Text>
      <Typography.Text code style={{ fontSize: token.fontSizeSM - 1 }}>
        {file.path}
      </Typography.Text>
      {file.moveTo && (
        <>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            →
          </Typography.Text>
          <Typography.Text code style={{ fontSize: token.fontSizeSM - 1 }}>
            {file.moveTo}
          </Typography.Text>
        </>
      )}
    </div>
  );
};

const fallbackLabel = (patchText: string | undefined, result: ToolRendererProps['result']) => {
  if (result?.is_error) return 'Patch failed';
  if (!result) return 'Patch pending';
  if (patchText) return 'Unable to parse patch';
  return 'Patch applied';
};

export const ApplyPatchRenderer: React.FC<ToolRendererProps> = ({ input, result }) => {
  const { token } = theme.useToken();
  const patchText = extractPatchText(input);
  const files = patchText ? parseApplyPatch(patchText) : [];
  const errorMessage = extractErrorMessage(result);

  if (files.length === 0) {
    return (
      <div>
        <Typography.Text
          type={result?.is_error ? 'danger' : 'secondary'}
          style={{ fontSize: token.fontSizeSM }}
        >
          {fallbackLabel(patchText, result)}
        </Typography.Text>
        {errorMessage && (
          <CollapsibleText
            code
            preserveWhitespace
            maxLines={4}
            style={{ marginTop: token.sizeUnit }}
          >
            {errorMessage}
          </CollapsibleText>
        )}
        {patchText && (
          <CollapsibleText
            code
            preserveWhitespace
            maxLines={12}
            style={{ marginTop: token.sizeUnit }}
          >
            {patchText}
          </CollapsibleText>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {files.map((file) =>
        file.structuredPatch.length > 0 ? (
          <DiffBlock
            key={fileKey(file)}
            filePath={displayPath(file)}
            operationType={fileChangeKindToOperationType(file.kind)}
            structuredPatch={file.structuredPatch}
            isError={result?.is_error}
            errorMessage={errorMessage}
            forceExpanded
          />
        ) : (
          <ApplyPatchFileRow key={fileKey(file)} file={file} />
        )
      )}
    </div>
  );
};
