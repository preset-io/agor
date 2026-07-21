import { readFileSync } from 'node:fs';
import { render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';
import { VegaLiteRendererGate } from './VegaLiteRendererGate';

const mocks = vi.hoisted(() => ({ loadRenderer: vi.fn() }));
const markdownRendererStyles = readFileSync(
  'src/components/MarkdownRenderer/MarkdownRenderer.css',
  'utf8'
);
let markdownRendererStyleElement: HTMLStyleElement;

vi.mock('./vegaRendererLoader', () => ({ loadVegaRenderer: mocks.loadRenderer }));

const doc = `# Knowledge Base: Next Steps\n\n- Add semantic and hybrid search once embeddings are configured.\n- Introduce smart document units/chunking for long pages, without exposing chunking as a user-facing concept.\n- Use Knowledge as durable memory for Agor teammates: preferences, project context, decisions, and reusable prompts.\n- Support skill bundles and lightweight import/export, including zip export later.\n- Keep polishing authoring: backlinks, better history/diff flows, and safer collaboration defaults.\n- autocomplete referencing from sessions and other places\n- Git syncing?`;

const asciiDiagram = [
  'User asks a question',
  '│',
  '├── Driver Diagnostics agent',
  '│   ├── search_web()',
  '│   └── read_web_page()',
  '└── Agent produces a cited answer',
];

const fenced = (language: string, lines: string[], closed = true) =>
  `\`\`\`${language}\n${lines.join('\n')}${closed ? '\n```' : ''}`;

describe('MarkdownRenderer', () => {
  beforeAll(() => {
    markdownRendererStyleElement = document.createElement('style');
    markdownRendererStyleElement.textContent = markdownRendererStyles;
    document.head.append(markdownRendererStyleElement);
  });

  afterAll(() => markdownRendererStyleElement.remove());

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

  it('preserves fenced text lines and exposes a compact, horizontally scrollable block', async () => {
    const { container } = render(
      <MarkdownRenderer content={fenced('text', asciiDiagram)} style={{ width: 192 }} />
    );

    await expectCodeLines(container, asciiDiagram);

    const header = container.querySelector<HTMLElement>('[data-streamdown="code-block-header"]');
    const actions = container.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]');
    const body = container.querySelector<HTMLElement>('[data-streamdown="code-block-body"]');
    const pre = body?.querySelector('pre');

    expect(container.firstElementChild).toHaveStyle({ width: '192px' });
    expect(header).toHaveTextContent('text');
    expect(header).toHaveStyle({ display: 'flex', height: '2rem' });
    expect(actions).toBeInTheDocument();
    expect(actions?.querySelectorAll('button')).toHaveLength(2);
    expect(actions?.parentElement).toHaveStyle({
      display: 'flex',
      height: '2rem',
      marginTop: '-2.5rem',
    });
    expect(body).toHaveStyle({ overflowX: 'auto' });
    expect(markdownRendererStyles).toContain('white-space: pre !important');
    const preStyles = getComputedStyle(pre as Element);
    expect(preStyles.minWidth).toBe('100%');
    expect(preStyles.whiteSpace).toBe('pre');
    expect(preStyles.width).toBe('max-content');
  });

  it('preserves fenced text geometry in the inline short-message mode', async () => {
    const { container } = render(
      <MarkdownRenderer content={fenced('text', asciiDiagram)} inline />
    );

    expect(container.querySelector('.inline-markdown')).toBeInTheDocument();
    await expectCodeLines(container, asciiDiagram);
  });

  it('preserves fenced text lines while an incomplete block streams to completion', async () => {
    const partialLines = asciiDiagram.slice(0, 4);
    const { container, rerender } = render(
      <MarkdownRenderer content={fenced('text', partialLines, false)} isStreaming />
    );

    await expectCodeLines(container, partialLines);

    rerender(<MarkdownRenderer content={fenced('text', asciiDiagram)} isStreaming />);

    await expectCodeLines(container, asciiDiagram);
  });

  it('preserves inline fenced text geometry while streaming to completion', async () => {
    const partialLines = asciiDiagram.slice(0, 4);
    const { container, rerender } = render(
      <MarkdownRenderer content={fenced('text', partialLines, false)} inline isStreaming />
    );

    expect(container.querySelector('.inline-markdown')).toBeInTheDocument();
    await expectCodeLines(container, partialLines);

    rerender(<MarkdownRenderer content={fenced('text', asciiDiagram)} inline isStreaming />);

    await expectCodeLines(container, asciiDiagram);
  });

  it('keeps the code body normal and scrollable when controls are hidden', async () => {
    const { container } = render(
      <MarkdownRenderer
        content={fenced('text', asciiDiagram)}
        inline
        showControls={false}
        style={{ width: 192 }}
      />
    );

    await expectCodeLines(container, asciiDiagram);

    const body = container.querySelector<HTMLElement>('[data-streamdown="code-block-body"]');
    expect(
      container.querySelector('[data-streamdown="code-block-actions"]')
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-streamdown="code-block-copy-button"]')
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-streamdown="code-block-download-button"]')
    ).not.toBeInTheDocument();
    expect(body).toHaveStyle({ overflowX: 'auto' });

    const bodyStyles = getComputedStyle(body as Element);
    expect(bodyStyles.position).not.toBe('sticky');
    expect(bodyStyles.display).not.toBe('flex');
    expect(bodyStyles.height).not.toBe('2rem');
    expect(bodyStyles.pointerEvents).not.toBe('none');
  });

  it('keeps ordinary code syntax-highlighted with its controls', async () => {
    const lines = ['const answer = 42;', 'console.log(answer);'];
    const { container } = render(<MarkdownRenderer content={fenced('typescript', lines)} />);

    await expectCodeLines(container, lines);
    expect(container.querySelector('[data-language="typescript"]')).toBeInTheDocument();
    expect(container.querySelector('[data-streamdown="code-block-copy-button"]')).toBeEnabled();
    expect(container.querySelector('[data-streamdown="code-block-download-button"]')).toBeEnabled();
    await waitFor(() => {
      const highlightedTokens = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-streamdown="code-block-body"] code > span > span'
        )
      );
      expect(
        highlightedTokens.some((token) => token.style.getPropertyValue('--sdm-c').length > 0)
      ).toBe(true);
    });
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

async function expectCodeLines(container: HTMLElement, expectedLines: string[]) {
  // jsdom drops the stylesheet property's !important priority. Reordering the
  // test style after Ant's runtime sheet preserves the intended browser cascade.
  document.head.append(markdownRendererStyleElement);
  await waitFor(() => {
    const lines = Array.from(
      container.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"] code > span')
    );
    expect(lines.map((line) => line.textContent)).toEqual(expectedLines);
    for (const line of lines) expect(line).toHaveStyle({ display: 'block' });
  });
}
