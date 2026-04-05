/**
 * WriteRenderer — Custom renderer for Write tool blocks.
 *
 * For new files: shows all content as additions.
 * For overwrites: uses executor-enriched structuredPatch if available.
 */

import type React from 'react';
import { DiffBlock } from './DiffBlock';
import type { ToolRendererProps } from './index';

export const WriteRenderer: React.FC<ToolRendererProps> = ({ toolUseId, input, result }) => {
  const filePath = input.file_path as string | undefined;
  const content = input.content as string | undefined;

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
      operationType="create"
      newContent={content}
      structuredPatch={result?.diff?.structuredPatch}
      isError={result?.is_error}
      errorMessage={errorMessage}
    />
  );
};
