import type { Heading, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface MarkdownHeadingRange {
  level: number;
  title: string;
  /**
   * Title-based breadcrumb, intended for display and convenience selection.
   * Duplicate title paths are disambiguated by `occurrence`.
   */
  headingPath: string;
  /**
   * Structural selector for this heading, e.g. `root.h1[1].h2[2]`.
   * This is title-independent within a document version, so it survives heading
   * renames better than `headingPath`, but it can still change when nearby
   * headings are inserted, deleted, or reordered.
   */
  sectionRef: string;
  /** Alias for `sectionRef` for callers that prefer explicit terminology. */
  ordinalPath: string;
  occurrence: number;
  startLine: number;
  endLine: number;
  contentStartLine: number;
  /** Raw markdown character count for the section, including its heading line. */
  chars: number;
  anchor: string;
}

export function splitMarkdownLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

function headingAnchor(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[`*_~[\]()]/g, '')
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

function nodeText(node: RootContent | Heading | unknown): string {
  if (!node || typeof node !== 'object') return '';
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return node.children
      .map((child) => nodeText(child))
      .join('')
      .trim();
  }
  return '';
}

export function markdownOutline(content: string, maxDepth = 6): MarkdownHeadingRange[] {
  const lines = splitMarkdownLines(content);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content);
  const raw = tree.children
    .filter((node): node is Heading => node.type === 'heading')
    .map((node) => ({
      level: node.depth,
      title: nodeText(node).trim(),
      line: node.position?.start.line ?? 1,
    }))
    .filter((heading) => heading.title.length > 0 && heading.level <= maxDepth);

  const titleStack: string[] = [];
  const ordinalStack: string[] = [];
  const occurrenceByPath = new Map<string, number>();
  const ordinalCountsByParentAndLevel = new Map<string, number>();
  return raw.map((heading, index) => {
    while (titleStack.length > heading.level - 1) titleStack.pop();
    titleStack.push(heading.title);
    const headingPath = titleStack.join(' > ');
    const occurrence = (occurrenceByPath.get(headingPath) ?? 0) + 1;
    occurrenceByPath.set(headingPath, occurrence);

    while (ordinalStack.length > heading.level - 1) ordinalStack.pop();
    const parentOrdinalPath = ordinalStack.length > 0 ? ordinalStack.join('.') : 'root';
    const ordinalCountKey = `${parentOrdinalPath}/h${heading.level}`;
    const ordinal = (ordinalCountsByParentAndLevel.get(ordinalCountKey) ?? 0) + 1;
    ordinalCountsByParentAndLevel.set(ordinalCountKey, ordinal);
    ordinalStack.push(`h${heading.level}[${ordinal}]`);
    const sectionRef = `root.${ordinalStack.join('.')}`;

    const next = raw.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const endLine = next ? next.line - 1 : lines.length;
    const sectionContent = lines.slice(heading.line - 1, endLine).join('\n');
    return {
      level: heading.level,
      title: heading.title,
      headingPath,
      sectionRef,
      ordinalPath: sectionRef,
      occurrence,
      startLine: heading.line,
      endLine,
      contentStartLine: Math.min(heading.line + 1, endLine),
      chars: sectionContent.length,
      anchor: headingAnchor(heading.title),
    };
  });
}

export function resolveHeadingRange(
  headings: MarkdownHeadingRange[],
  headingPath: string,
  occurrence = 1
): MarkdownHeadingRange {
  const matches = headings.filter((heading) => heading.headingPath === headingPath);
  if (matches.length === 0) throw new Error(`Heading not found: ${headingPath}`);
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    throw new Error('occurrence must be a positive integer');
  }
  const match = matches[occurrence - 1];
  if (!match) {
    throw new Error(
      `Heading "${headingPath}" occurrence ${occurrence} not found (matches: ${matches.length})`
    );
  }
  return match;
}

export function resolveSectionRefRange(
  headings: MarkdownHeadingRange[],
  sectionRef: string
): MarkdownHeadingRange {
  const normalized = sectionRef.trim();
  const match = headings.find(
    (heading) => heading.sectionRef === normalized || heading.ordinalPath === normalized
  );
  if (!match) throw new Error(`Section ref not found: ${sectionRef}`);
  return match;
}
