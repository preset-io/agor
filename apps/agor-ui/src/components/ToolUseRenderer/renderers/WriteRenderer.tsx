/**
 * WriteRenderer — Custom renderer for Write tool blocks.
 *
 * For new files: shows all content as additions.
 * For overwrites: uses executor-enriched structuredPatch if available.
 */

import type React from 'react';
import { DiffBlock } from './DiffBlock';
import { extractErrorMessage, type ToolRendererProps } from './index';

export const WriteRenderer: React.FC<ToolRendererProps> = ({ input, result }) => {
  const filePath = input.file_path as string | undefined;
  const content = input.content as string | undefined;

  if (!filePath) return null;

  return (
    <DiffBlock
      filePath={filePath}
      operationType="create"
      newContent={content}
      structuredPatch={result?.diff?.structuredPatch}
      isError={result?.is_error}
      errorMessage={extractErrorMessage(result)}
      forceExpanded
    />
  );
};
