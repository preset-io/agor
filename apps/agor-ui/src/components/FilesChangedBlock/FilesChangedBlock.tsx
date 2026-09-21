/**
 * FilesChangedBlock — one grouped disclosure for everything a turn edited.
 *
 * Compact collapses activity into quiet rows, which would bury a turn's actual
 * output inside a subagent chain. This lifts the edits out to the turn level:
 * collapsed it is one line with the change size, expanded it is the per-file
 * diffs. Edits it covers are hidden from the activity rows so they read once.
 */

import { FileTextOutlined } from '@ant-design/icons';
import { theme } from 'antd';
import React from 'react';
import { COMPACT_BLOCK_GAP_UNITS } from '../ConversationView/compactLayout';
import { buildDiffStatNode, ToolBlock } from '../ToolBlock';
import { DiffBlock } from '../ToolUseRenderer/renderers/DiffBlock';
import type { TaskFileChanges } from './taskFileChanges';

const basename = (path: string): string => path.split('/').filter(Boolean).pop() || path;

export const FilesChangedBlock = React.memo<{ summary: TaskFileChanges | null }>(({ summary }) => {
  const { token } = theme.useToken();

  if (!summary) return null;

  const label =
    summary.fileCount === 1
      ? basename(summary.changes[0].path)
      : `${summary.fileCount} files changed`;

  return (
    <div
      data-conversation-block
      style={{ margin: `${token.sizeUnit * COMPACT_BLOCK_GAP_UNITS}px 0` }}
    >
      <ToolBlock
        compact
        icon={<FileTextOutlined />}
        name={label}
        descriptionNode={buildDiffStatNode(summary, token)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {summary.changes.map((change) => (
            <DiffBlock
              key={change.key}
              filePath={change.path}
              operationType={change.operation}
              structuredPatch={change.structuredPatch}
              forceExpanded
            />
          ))}
        </div>
      </ToolBlock>
    </div>
  );
});

FilesChangedBlock.displayName = 'FilesChangedBlock';
