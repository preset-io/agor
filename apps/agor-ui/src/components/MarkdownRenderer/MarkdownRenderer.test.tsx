import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

const doc = `# Knowledge Base: Next Steps\n\n- Add semantic and hybrid search once embeddings are configured.\n- Introduce smart document units/chunking for long pages, without exposing chunking as a user-facing concept.\n- Use Knowledge as durable memory for Agor teammates: preferences, project context, decisions, and reusable prompts.\n- Support skill bundles and lightweight import/export, including zip export later.\n- Keep polishing authoring: backlinks, better history/diff flows, and safer collaboration defaults.\n- autocomplete referencing from sessions and other places\n- Git syncing?`;

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

  it('adds stable ids and self-links when heading anchors are enabled', async () => {
    const { container } = render(<MarkdownRenderer content={'## Foo\n\n## Foo!'} headingAnchors />);

    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((heading) => heading.id)).toEqual(['foo', 'foo-1']);
    const firstAnchor = container.querySelector('a.markdown-heading-anchor[href="#foo"]');
    expect(firstAnchor).toBeInTheDocument();
    expect(firstAnchor).not.toHaveAttribute('target', '_blank');
    expect(container.querySelector('a.markdown-heading-anchor[href="#foo-1"]')).toBeInTheDocument();
  });

  it('renders GitHub alert syntax as a semantic, themed callout', async () => {
    const { container } = render(
      <MarkdownRenderer content={'> [!WARNING]\n> Deployments are paused.'} />
    );

    expect(await screen.findByText('Deployments are paused.')).toBeInTheDocument();
    const callout = container.querySelector('blockquote.markdown-alert-warning');
    expect(callout).toBeInTheDocument();
    expect(callout).toHaveTextContent('WARNING');
  });

  it('keeps an incomplete Vega-Lite fence as copyable code while streaming', async () => {
    const source = '```vega-lite\n{"mark":"bar"';
    const { container } = render(<MarkdownRenderer content={source} isStreaming />);

    expect(await screen.findByText(/"mark"/)).toBeInTheDocument();
    expect(container.querySelector('[data-language="vega-lite"]')).toBeInTheDocument();
    expect(
      container.querySelector('[aria-label="Vega-Lite data visualization"]')
    ).not.toBeInTheDocument();
  });
});
