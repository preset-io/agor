import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

const doc = `# Knowledge Base: Next Steps\n\n- Add semantic and hybrid search once embeddings are configured.\n- Introduce smart document units/chunking for long pages, without exposing chunking as a user-facing concept.\n- Use Knowledge as durable memory for Agor Assistants: preferences, project context, decisions, and reusable prompts.\n- Support skill bundles and lightweight import/export, including zip export later.\n- Keep polishing authoring: backlinks, better history/diff flows, and safer collaboration defaults.\n- autocomplete referencing from sessions and other places\n- Git syncing?`;

describe('MarkdownRenderer', () => {
  it('refreshes preview text when an earlier bullet list item changes', async () => {
    const { rerender } = render(<MarkdownRenderer content={doc} />);
    expect(screen.getByText(/Git syncing\?/)).toBeInTheDocument();
    rerender(<MarkdownRenderer content={doc.replace('Add semantic', 'Add amazing semantic')} />);

    expect(
      await screen.findByText(
        'Add amazing semantic and hybrid search once embeddings are configured.'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Add semantic and hybrid search once embeddings are configured.')
    ).not.toBeInTheDocument();
  });
});
