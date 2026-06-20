const HEADING_TAG_RE = /^h[1-6]$/;

interface HeadingSluggerState {
  seen: Map<string, number>;
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: unknown;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function slugifyHeadingText(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || 'heading';
}

export function createHeadingSlugger() {
  const state: HeadingSluggerState = { seen: new Map() };

  return (text: string): string => {
    const base = slugifyHeadingText(text);
    const count = state.seen.get(base) ?? 0;
    state.seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

export function extractHastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') {
    return typeof node.value === 'string' ? node.value : '';
  }
  return (node.children ?? []).map(extractHastText).join('');
}

function visit(node: HastNode, visitor: (node: HastNode) => void) {
  visitor(node);
  for (const child of node.children ?? []) visit(child, visitor);
}

/**
 * Rehype plugin that assigns deterministic GitHub-like ids to headings and adds
 * a small self-link. The slugger is per rendered markdown document, so duplicate
 * headings become `foo`, `foo-1`, `foo-2` in source order.
 */
export function rehypeHeadingAnchors() {
  return (tree: HastNode) => {
    const slug = createHeadingSlugger();

    visit(tree, (node) => {
      if (node.type !== 'element' || !node.tagName || !HEADING_TAG_RE.test(node.tagName)) return;

      const text = extractHastText(node);
      const id = slug(text);
      node.properties = { ...(node.properties ?? {}), id };
      node.children = [
        ...(node.children ?? []),
        {
          type: 'element',
          tagName: 'a',
          properties: {
            className: ['markdown-heading-anchor'],
            href: `#${id}`,
            ariaLabel: `Link to ${text || 'heading'}`,
          },
          children: [{ type: 'text', value: '#' }],
        },
      ];
    });
  };
}
