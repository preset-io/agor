import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolUseRenderer } from './ToolUseRenderer';

vi.mock('./renderers', () => ({
  getToolRenderer: () => () => <div>Full diff renderer</div>,
}));
vi.mock('../ThemedSyntaxHighlighter', () => ({
  ThemedSyntaxHighlighter: ({ children }: { children: string }) => <pre>{children}</pre>,
}));

describe('ToolUseRenderer transcript projections', () => {
  const toolUse = {
    type: 'tool_use' as const,
    id: 't1',
    name: 'Write',
    input: { file_path: 'state.json', content: 'original' },
  };
  const toolResult = {
    type: 'tool_result' as const,
    tool_use_id: 't1',
    content: 'write succeeded',
  };

  it('keeps the specialized renderer for complete data', () => {
    render(<ToolUseRenderer toolUse={toolUse} toolResult={toolResult} />);
    expect(screen.getByText('Full diff renderer')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it.each(['input', 'diff', 'content'])(
    'shows a visible size notice and plain output instead of a full diff for shortened %s',
    (field) => {
      const marker = { [field]: { original_bytes: 1_000_000 } };
      render(
        <ToolUseRenderer
          toolUse={
            field === 'input'
              ? {
                  ...toolUse,
                  transcript_truncation: marker,
                  input: { notice: 'Tool input omitted' },
                }
              : toolUse
          }
          toolResult={
            field === 'input'
              ? toolResult
              : { ...toolResult, transcript_truncation: marker, is_error: true }
          }
        />
      );
      expect(screen.queryByText('Full diff renderer')).not.toBeInTheDocument();
      expect(screen.getByRole('note')).toHaveTextContent(`Transcript shortened: ${field}`);
      expect(screen.getByRole('note')).toHaveTextContent('1,000,000 serialized bytes');
      expect(screen.getByText('write succeeded')).toBeInTheDocument();
      expect(screen.getByText('Input parameters')).toBeInTheDocument();
    }
  );

  it('shows the notice before the tool result arrives', () => {
    render(
      <ToolUseRenderer
        toolUse={{ ...toolUse, transcript_truncation: { input: { original_bytes: 1_000_000 } } }}
      />
    );
    expect(screen.getByRole('note')).toHaveTextContent('Transcript shortened: input');
    expect(screen.queryByText('Full diff renderer')).not.toBeInTheDocument();
  });
});
