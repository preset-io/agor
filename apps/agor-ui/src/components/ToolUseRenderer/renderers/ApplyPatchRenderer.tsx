/**
 * ApplyPatchRenderer — Custom renderer for Codex's apply_patch tool.
 *
 * Codex emits apply_patch as a custom tool whose input is already a patch-like
 * diff. It does not go through the executor-side edit_files snapshot enrichment,
 * so render the patch directly instead of treating the whole patch text as a
 * new file/addition.
 */

import { Typography, theme } from 'antd';
import type React from 'react';
import { CollapsibleText } from '../../CollapsibleText';
import { DiffBlock } from './DiffBlock';
import type { StructuredPatchHunk } from './DiffBlock/useDiff';
import type { ToolRendererProps } from './index';

type ApplyPatchFileKind = 'add' | 'update' | 'delete';

export interface ParsedApplyPatchFile {
  path: string;
  kind: ApplyPatchFileKind;
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
const HUNK_RE = /^@@(?:\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?)?.*@@/;

const headerKindToFileKind = (kind: string): ApplyPatchFileKind => {
  switch (kind) {
    case 'Add':
      return 'add';
    case 'Delete':
      return 'delete';
    default:
      return 'update';
  }
};

const kindToOperationType = (kind: ApplyPatchFileKind): 'edit' | 'create' | 'delete' => {
  switch (kind) {
    case 'add':
      return 'create';
    case 'delete':
      return 'delete';
    default:
      return 'edit';
  }
};

const fileKey = (file: ParsedApplyPatchFile): string => {
  const hunkSignature = file.structuredPatch
    .map((hunk) => `${hunk.oldStart}:${hunk.newStart}:${hunk.lines.length}`)
    .join('|');
  return `${file.kind}:${file.path}:${hunkSignature}`;
};

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

function defaultHunkForKind(kind: ApplyPatchFileKind): MutableHunk {
  if (kind === 'add') {
    return { oldStart: 0, newStart: 1, explicitOldLines: 0, lines: [] };
  }
  if (kind === 'delete') {
    return { oldStart: 1, newStart: 0, explicitNewLines: 0, lines: [] };
  }
  return { oldStart: 1, newStart: 1, lines: [] };
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
        kind: ApplyPatchFileKind;
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
    if (current && current.hunks.length > 0) {
      files.push({
        path: current.path,
        kind: current.kind,
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

    if (line === '*** End Patch' || line.startsWith('*** ')) {
      flushFile();
      continue;
    }

    const hunkHeader = line.match(HUNK_RE);
    if (hunkHeader) {
      flushHunk();
      currentHunk = {
        oldStart: hunkHeader[1] ? Number(hunkHeader[1]) : 1,
        explicitOldLines: hunkHeader[2] ? Number(hunkHeader[2]) : undefined,
        newStart: hunkHeader[3] ? Number(hunkHeader[3]) : 1,
        explicitNewLines: hunkHeader[4] ? Number(hunkHeader[4]) : undefined,
        lines: [],
      };
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

export const ApplyPatchRenderer: React.FC<ToolRendererProps> = ({ input, result }) => {
  const { token } = theme.useToken();
  const patchText = extractPatchText(input);
  const files = patchText ? parseApplyPatch(patchText) : [];

  if (files.length === 0) {
    return (
      <div>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          Patch applied
        </Typography.Text>
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
      {files.map((file) => (
        <DiffBlock
          key={fileKey(file)}
          filePath={file.path}
          operationType={kindToOperationType(file.kind)}
          structuredPatch={file.structuredPatch}
          isError={result?.is_error}
          forceExpanded
        />
      ))}
    </div>
  );
};
