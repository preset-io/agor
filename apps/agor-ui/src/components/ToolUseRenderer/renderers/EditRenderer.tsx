/**
 * EditRenderer — Custom renderer for Edit tool blocks.
 *
 * Maps Edit tool input (file_path, old_string, new_string) to DiffBlock.
 * Uses executor-enriched structuredPatch when available, falls back to
 * client-side diffing from old_string/new_string.
 */

import type React from 'react';
import { DiffBlock } from './DiffBlock';
import { extractErrorMessage, type ToolRendererProps } from './index';

export const EditRenderer: React.FC<ToolRendererProps> = ({ input, result }) => {
  const filePath = input.file_path as string | undefined;
  const oldString = input.old_string as string | undefined;
  const newString = input.new_string as string | undefined;

  if (!filePath) return null;

  return (
    <DiffBlock
      filePath={filePath}
      operationType="edit"
      oldContent={oldString}
      newContent={newString}
      structuredPatch={result?.diff?.structuredPatch}
      isError={result?.is_error}
      errorMessage={extractErrorMessage(result)}
    />
  );
};
