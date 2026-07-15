import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';
import { VegaLiteRendererGate } from './VegaLiteRendererGate';

const mocks = vi.hoisted(() => ({ loadRenderer: vi.fn() }));

vi.mock('./vegaRendererLoader', () => ({ loadVegaRenderer: mocks.loadRenderer }));

const doc = `# Knowledge Base: Next Steps\n\n- Add semantic and hybrid search once embeddings are configured.\n- Introduce smart document units/chunking for long pages, without exposing chunking as a user-facing concept.\n- Use Knowledge as durable memory for Agor teammates: preferences, project context, decisions, and reusable prompts.\n- Support skill bundles and lightweight import/export, including zip export later.\n- Keep polishing authoring: backlinks, better history/diff flows, and safer collaboration defaults.\n- autocomplete referencing from sessions and other places\n- Git syncing?`;

describe('MarkdownRenderer', () => {
  beforeEach(() => {
    mocks.loadRenderer.mockReset();
    mocks.loadRenderer.mockResolvedValue({
      VegaLiteRenderer: () => <div data-testid="vega-lite-renderer" />,
    });
  });

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
    const { container } = render(<MarkdownRenderer content={source} enableVegaLite isStreaming />);

    expect(await screen.findByText(/"mark"/)).toBeInTheDocument();
    expect(container.querySelector('[data-language="vega-lite"]')).toBeInTheDocument();
    expect(
      container.querySelector('[aria-label="Vega-Lite data visualization"]')
    ).not.toBeInTheDocument();
  });

  it('keeps Vega-Lite as ordinary code unless the POC is explicitly enabled', async () => {
    const source = '```vega-lite\n{"description":"Chart","mark":"bar"}\n```';
    const { container } = render(<MarkdownRenderer content={source} />);

    expect(await screen.findByText(/"description"/)).toBeInTheDocument();
    expect(container.querySelector('figure[aria-label="Chart"]')).not.toBeInTheDocument();
  });

  it('fails closed when the Vega renderer gate has no activation-budget owner', async () => {
    const { container } = render(
      <VegaLiteRendererGate
        code={'{"description":"Chart","mark":"bar"}'}
        isIncomplete={false}
        language="vega-lite"
      />
    );

    expect(await screen.findByText(/"description"/)).toBeInTheDocument();
    expect(container.querySelector('[data-language="vega-lite"]')).toBeInTheDocument();
    expect(mocks.loadRenderer).not.toHaveBeenCalled();
  });

  it('activates no more than four top-level charts in one Markdown document', async () => {
    const fence = '```vega-lite\n{"description":"Chart","mark":"bar"}\n```';
    render(
      <MarkdownRenderer
        content={Array.from({ length: 5 }, () => fence).join('\n\n')}
        enableVegaLite
      />
    );

    expect(await screen.findAllByTestId('vega-lite-renderer')).toHaveLength(4);
    expect(mocks.loadRenderer).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      'blockquotes',
      Array.from(
        { length: 5 },
        () => '> ```vega-lite\n> {"description":"Chart","mark":"bar"}\n> ```'
      ).join('\n\n'),
    ],
    [
      'list items',
      Array.from(
        { length: 5 },
        (_, index) =>
          `- chart ${index + 1}\n\n  \`\`\`vega-lite\n  {"description":"Chart","mark":"bar"}\n  \`\`\``
      ).join('\n\n'),
    ],
  ])('enforces the renderer activation budget inside %s', async (_label, content) => {
    render(<MarkdownRenderer content={content} enableVegaLite />);

    expect(await screen.findAllByTestId('vega-lite-renderer')).toHaveLength(4);
    expect(mocks.loadRenderer).toHaveBeenCalledTimes(4);
  });
});
