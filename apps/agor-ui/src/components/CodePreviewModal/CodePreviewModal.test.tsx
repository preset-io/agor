import type { FileDetail } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({ showSuccess: vi.fn() }),
}));

vi.mock('@/components/ThemedSyntaxHighlighter', () => ({
  ThemedSyntaxHighlighter: ({ children }: { children: string }) => (
    <pre data-testid="file-content">{children}</pre>
  ),
}));

vi.mock('../ToolUseRenderer/renderers/DiffBlock', () => ({
  DiffBlock: ({
    oldContent,
    newContent,
    operationType,
  }: {
    oldContent: string;
    newContent: string;
    operationType: string;
  }) => (
    <div data-testid="file-diff">
      {operationType}:{oldContent}:{newContent}
    </div>
  ),
}));

import { CodePreviewModal } from './CodePreviewModal';

const modifiedFile: FileDetail = {
  path: 'src/example.ts',
  title: 'example.ts',
  size: 20,
  lastModified: '2026-08-30T00:00:00.000Z',
  isText: true,
  gitStatus: 'modified',
  content: 'const value = 2;\n',
  encoding: 'utf-8',
  gitDiff: { baseContent: 'const value = 1;\n' },
};

describe('CodePreviewModal git changes', () => {
  it('lets a user switch from the current file to its HEAD diff', () => {
    render(<CodePreviewModal file={modifiedFile} open onClose={vi.fn()} />);

    expect(screen.getByTestId('file-content')).toHaveTextContent('const value = 2;');

    fireEvent.click(screen.getByText('Changes'));

    expect(screen.getByTestId('file-diff')).toHaveTextContent(
      'edit:const value = 1; :const value = 2;'
    );
  });

  it('opens a deleted file directly in diff mode', () => {
    render(
      <CodePreviewModal
        file={{
          ...modifiedFile,
          path: 'src/deleted.ts',
          gitStatus: 'deleted',
          content: '',
        }}
        open
        onClose={vi.fn()}
      />
    );

    expect(screen.getByTestId('file-diff')).toHaveTextContent('delete:const value = 1; :');
    expect(screen.queryByTestId('file-content')).not.toBeInTheDocument();
  });
});
