import { createHash } from 'node:crypto';
import type { Heading, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface MarkdownHeadingRange {
  level: number;
  title: string;
  headingPath: string;
  occurrence: number;
  startLine: number;
  endLine: number;
  contentStartLine: number;
  anchor: string;
  contentMd5: string;
}

export function splitMarkdownLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
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

  const pathStack: string[] = [];
  const occurrenceByPath = new Map<string, number>();
  return raw.map((heading, index) => {
    pathStack.length = heading.level - 1;
    pathStack[heading.level - 1] = heading.title;
    const headingPath = pathStack.filter(Boolean).join(' > ');
    const occurrence = (occurrenceByPath.get(headingPath) ?? 0) + 1;
    occurrenceByPath.set(headingPath, occurrence);
    const next = raw.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const endLine = next ? next.line - 1 : lines.length;
    const sectionContent = lines.slice(heading.line - 1, endLine).join('\n');
    return {
      level: heading.level,
      title: heading.title,
      headingPath,
      occurrence,
      startLine: heading.line,
      endLine,
      contentStartLine: Math.min(heading.line + 1, endLine),
      anchor: headingAnchor(heading.title),
      contentMd5: md5(sectionContent),
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
