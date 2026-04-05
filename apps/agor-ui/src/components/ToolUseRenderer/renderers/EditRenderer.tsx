/**
 * EditRenderer — Custom renderer for Edit tool blocks.
 *
 * Maps Edit tool input (file_path, old_string, new_string) to DiffBlock.
 * Uses executor-enriched structuredPatch when available, falls back to
 * client-side diffing from old_string/new_string.
 */

import type React from 'react';
import { DiffBlock } from './DiffBlock';
import type { ToolRendererProps } from './index';

export const EditRenderer: React.FC<ToolRendererProps> = ({ toolUseId, input, result }) => {
  const filePath = input.file_path as string | undefined;
  const oldString = input.old_string as string | undefined;
  const newString = input.new_string as string | undefined;
  const replaceAll = input.replace_all as boolean | undefined;

  if (!filePath) return null;

  // Extract error message
  let errorMessage: string | undefined;
  if (result?.is_error) {
    if (typeof result.content === 'string') {
      errorMessage = result.content;
    } else if (Array.isArray(result.content)) {
      errorMessage = result.content
        .filter((b): b is { type: 'text'; text: string } => {
          const block = b as { type: string; text?: string };
          return block.type === 'text';
        })
        .map((b) => b.text)
        .join('\n');
    }
  }

  return (
    <DiffBlock
      toolUseId={toolUseId}
      filePath={filePath}
      operationType="edit"
      oldContent={oldString}
      newContent={newString}
      replaceAll={replaceAll}
      structuredPatch={result?.diff?.structuredPatch}
      isError={result?.is_error}
      errorMessage={errorMessage}
    />
  );
};
