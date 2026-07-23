// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive ConfigProvider tokens verify fullscreen portal theme inheritance
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STREAMDOWN_MERMAID_Z_INDEX_VARIABLE,
  STREAMDOWN_PORTAL_ROOT_CLASS_NAME,
  StreamdownPortalApp,
} from '../StreamdownPortalApp';
import { MarkdownRenderer } from './MarkdownRenderer';
import { VegaLiteRendererGate } from './VegaLiteRendererGate';

const mocks = vi.hoisted(() => ({ loadRenderer: vi.fn() }));
const markdownRendererStyles = readFileSync(
  'src/components/MarkdownRenderer/MarkdownRenderer.css',
  'utf8'
);
let markdownRendererStyleElement: HTMLStyleElement;

vi.mock('@streamdown/mermaid', () => ({
  mermaid: {
    getMermaid: () => ({
      initialize: vi.fn(),
      render: vi.fn().mockResolvedValue({
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><title>Diagram</title></svg>',
      }),
    }),
    language: 'mermaid',
    name: 'mermaid',
    type: 'diagram',
  },
}));
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

const fullscreenTheme = {
  token: {
    colorBgElevated: '#123456',
    zIndexPopupBase: 4321,
  },
};

describe('MarkdownRenderer', () => {
  beforeAll(() => {
    markdownRendererStyleElement = document.createElement('style');
    markdownRendererStyleElement.textContent = markdownRendererStyles;
    document.head.append(markdownRendererStyleElement);
  });

  afterAll(() => markdownRendererStyleElement.remove());

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('renders links as new-tab anchors without a confirmation interstitial', async () => {
    render(<MarkdownRenderer content={'[Private PR #1](https://github.com/acme/repo/pull/1)'} />);

    // Link safety is disabled, so links are plain anchors (not <button>s) that
    // open in a new tab — no modal, no click interception.
    const link = await screen.findByRole('link', { name: 'Private PR #1' });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/repo/pull/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));

    fireEvent.click(link);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
      marginTop: '-2rem',
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

  it('opens completed Mermaid diagrams in an interactive, dismissible dialog', async () => {
    class IntersectionObserverStub {
      private readonly callback: IntersectionObserverCallback;

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }

      disconnect() {}

      observe(target: Element) {
        this.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver
        );
      }

      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }

      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);

    const { container } = render(
      <ConfigProvider theme={fullscreenTheme}>
        <StreamdownPortalApp>
          <MarkdownRenderer content={'```mermaid\nflowchart LR\n  A --> B\n```'} />
        </StreamdownPortalApp>
      </ConfigProvider>
    );

    expect(await screen.findByRole('img', { name: 'Mermaid chart' })).toBeInTheDocument();
    expect(container.querySelector('[data-streamdown="mermaid-block"]')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const openFullscreen = screen.getByTitle('View fullscreen');
    fireEvent.click(openFullscreen);

    const dialog = await screen.findByRole('dialog', { name: 'View fullscreen' });
    expect(dialog).toHaveAttribute('data-streamdown', 'mermaid-fullscreen');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const portalRoot = container.querySelector(`.${STREAMDOWN_PORTAL_ROOT_CLASS_NAME}`);
    expect(portalRoot).toContainElement(dialog);
    // jsdom does not expose inherited custom properties on descendants, so
    // prove both halves of browser resolution: the portal is inside the Ant
    // App scope and that exact scope resolves the configured token values.
    const portalRootStyle = window.getComputedStyle(portalRoot as Element);
    for (const tokenName of [
      '--ant-border-radius-sm',
      '--ant-color-bg-elevated',
      '--ant-color-border',
      '--ant-color-text-secondary',
      '--ant-padding-lg',
    ]) {
      expect(portalRootStyle.getPropertyValue(tokenName).trim(), tokenName).not.toBe('');
    }
    expect(portalRootStyle.getPropertyValue('--ant-color-bg-elevated').trim()).toBe(
      fullscreenTheme.token.colorBgElevated
    );
    expect(portalRootStyle.getPropertyValue(STREAMDOWN_MERMAID_Z_INDEX_VARIABLE).trim()).toBe(
      String(fullscreenTheme.token.zIndexPopupBase)
    );
    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));

    const fullscreenViewer = within(dialog).getByRole('application');
    Object.defineProperties(fullscreenViewer, {
      releasePointerCapture: { value: vi.fn() },
      setPointerCapture: { value: vi.fn() },
    });
    fireEvent.click(within(dialog).getByTitle('Zoom in'));
    expect(fullscreenViewer).toHaveStyle({ transform: 'translate(0px, 0px) scale(1.1)' });
    fireEvent.pointerDown(fullscreenViewer, {
      button: 0,
      clientX: 10,
      clientY: 20,
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(fullscreenViewer, { clientX: 40, clientY: 60, pointerId: 1 });
    expect(fullscreenViewer).toHaveStyle({ transform: 'translate(30px, 40px) scale(1.1)' });
    fireEvent.pointerUp(fullscreenViewer, { pointerId: 1 });

    fireEvent.click(within(dialog).getByTitle('Exit fullscreen'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');

    fireEvent.click(openFullscreen);
    fireEvent.click(await screen.findByRole('dialog', { name: 'View fullscreen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');

    fireEvent.click(openFullscreen);
    await screen.findByRole('dialog', { name: 'View fullscreen' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');
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
