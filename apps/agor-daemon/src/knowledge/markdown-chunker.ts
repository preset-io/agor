import { createHash } from 'node:crypto';
import type { RootContent } from 'mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface MarkdownChunkerOptions {
  targetTokens?: number;
  maxTokens?: number;
  overlapTokens?: number;
  minTokens?: number;
  includeHeadingPath?: boolean;
  includeDocumentTitle?: boolean;
  chunkerVersion?: string;
}

export interface MarkdownKnowledgeChunk {
  kind: 'section' | 'auto_split';
  ordinal: number;
  path_anchor: string | null;
  heading_path: string | null;
  content_text: string;
  content_md5: string;
  start_offset: number | null;
  end_offset: number | null;
  metadata: Record<string, unknown>;
}

interface SectionDraft {
  headingPath: string[];
  blocks: RootContent[];
  startOffset: number | null;
  endOffset: number | null;
}

const DEFAULTS: Required<MarkdownChunkerOptions> = {
  targetTokens: 850,
  maxTokens: 1200,
  overlapTokens: 100,
  minTokens: 80,
  includeHeadingPath: true,
  includeDocumentTitle: true,
  chunkerVersion: 'agor-markdown-remark-v1',
};

function estimateTokens(text: string): number {
  // Cheap, deterministic approximation good enough for chunk boundaries. The
  // embedding provider returns actual usage where available.
  return Math.ceil(text.trim().length / 4);
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[`*_~[\]()]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

function nodeText(node: RootContent): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) {
    return node.children
      .map((child) => ('value' in child && typeof child.value === 'string' ? child.value : ''))
      .join(' ')
      .trim();
  }
  return '';
}

function nodeMarkdown(node: RootContent): string {
  return toMarkdown(
    { type: 'root', children: [node] },
    { bullet: '-', extensions: [gfmToMarkdown()], fences: true }
  ).trim();
}

function offsetsFor(nodes: RootContent[]): { start: number | null; end: number | null } {
  let start: number | null = null;
  let end: number | null = null;
  for (const node of nodes) {
    const nodeStart = node.position?.start.offset;
    const nodeEnd = node.position?.end.offset;
    if (typeof nodeStart === 'number')
      start = start === null ? nodeStart : Math.min(start, nodeStart);
    if (typeof nodeEnd === 'number') end = end === null ? nodeEnd : Math.max(end, nodeEnd);
  }
  return { start, end };
}

function takeOverlap(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return '';
  const words = text.trim().split(/\s+/);
  const approxWords = Math.max(1, Math.floor(overlapTokens * 0.75));
  return words.slice(-approxWords).join(' ');
}

function splitLongBlock(
  block: string,
  headingPath: string[],
  opts: Required<MarkdownChunkerOptions>
): string[] {
  const chunks: string[] = [];
  const lines = block.split('\n');
  let lineChunk = '';

  for (const line of lines) {
    const lineCandidate = lineChunk ? `${lineChunk}\n${line}` : line;
    if (estimateTokens(makeChunkText(headingPath, lineCandidate, opts)) <= opts.maxTokens) {
      lineChunk = lineCandidate;
      continue;
    }

    if (lineChunk) chunks.push(lineChunk);
    if (estimateTokens(makeChunkText(headingPath, line, opts)) <= opts.maxTokens) {
      lineChunk = line;
      continue;
    }

    const words = line
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((word) =>
        estimateTokens(makeChunkText(headingPath, word, opts)) > opts.maxTokens
          ? (word.match(/.{1,240}/g) ?? [])
          : [word]
      );
    let wordChunk = '';
    for (const word of words.length > 0 ? words : (line.match(/.{1,240}/g) ?? [])) {
      const wordCandidate = wordChunk ? `${wordChunk} ${word}` : word;
      if (estimateTokens(makeChunkText(headingPath, wordCandidate, opts)) <= opts.maxTokens) {
        wordChunk = wordCandidate;
      } else {
        if (wordChunk) chunks.push(wordChunk);
        wordChunk = word;
      }
    }
    lineChunk = wordChunk;
  }

  if (lineChunk) chunks.push(lineChunk);
  return chunks;
}

function makeChunkText(
  headingPath: string[],
  body: string,
  opts: Required<MarkdownChunkerOptions>
): string {
  const headingPrefix =
    opts.includeHeadingPath && headingPath.length > 0 ? `${headingPath.join(' > ')}\n\n` : '';
  return `${headingPrefix}${body}`.trim();
}

function splitOversizedText(
  body: string,
  headingPath: string[],
  opts: Required<MarkdownChunkerOptions>
): string[] {
  const targetTokens = Math.min(opts.targetTokens, opts.maxTokens);
  const paragraphs = body.split(/\n{2,}/).filter((part) => part.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (estimateTokens(makeChunkText(headingPath, candidate, opts)) <= targetTokens) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      const overlap = takeOverlap(current, opts.overlapTokens);
      const next = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
      if (estimateTokens(makeChunkText(headingPath, next, opts)) <= opts.maxTokens) {
        current = next;
      } else {
        chunks.push(...splitLongBlock(next, headingPath, opts));
        current = '';
      }
    } else {
      chunks.push(...splitLongBlock(paragraph, headingPath, opts));
      current = '';
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export function chunkMarkdownForKnowledge(
  markdown: string,
  options: MarkdownChunkerOptions = {}
): MarkdownKnowledgeChunk[] {
  const opts = { ...DEFAULTS, ...options };
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const sections: SectionDraft[] = [];
  let headingStack: Array<{ depth: number; text: string }> = [];
  let current: SectionDraft = { headingPath: [], blocks: [], startOffset: null, endOffset: null };

  const flush = () => {
    if (current.blocks.length === 0) return;
    const { start, end } = offsetsFor(current.blocks);
    sections.push({ ...current, startOffset: start, endOffset: end });
  };

  for (const node of tree.children) {
    if (node.type === 'heading') {
      flush();
      const text = nodeText(node).trim();
      const isDocumentTitle =
        !opts.includeDocumentTitle &&
        node.depth === 1 &&
        sections.length === 0 &&
        current.blocks.length === 0 &&
        headingStack.length === 0;
      if (isDocumentTitle) {
        current = { headingPath: [], blocks: [], startOffset: null, endOffset: null };
        continue;
      }
      headingStack = headingStack.filter((item) => item.depth < node.depth);
      if (text) headingStack.push({ depth: node.depth, text });
      current = {
        headingPath: headingStack.map((item) => item.text),
        blocks: [node],
        startOffset: null,
        endOffset: null,
      };
      continue;
    }

    if (current.blocks.length === 0 && sections.length === 0) {
      current.headingPath = [];
    }
    current.blocks.push(node);
  }
  flush();

  if (sections.length === 0 && markdown.trim()) {
    sections.push({ headingPath: [], blocks: [], startOffset: 0, endOffset: markdown.length });
  }

  const rawChunks: Array<Omit<MarkdownKnowledgeChunk, 'ordinal' | 'content_md5'>> = [];
  for (const section of sections) {
    const body =
      section.blocks.length > 0
        ? section.blocks.map(nodeMarkdown).filter(Boolean).join('\n\n')
        : markdown.trim();
    if (!body.trim()) continue;
    const bodies =
      estimateTokens(makeChunkText(section.headingPath, body, opts)) <=
      Math.min(opts.targetTokens, opts.maxTokens)
        ? [body]
        : splitOversizedText(body, section.headingPath, opts);

    for (let index = 0; index < bodies.length; index++) {
      const content = makeChunkText(section.headingPath, bodies[index], opts);
      if (!content) continue;
      rawChunks.push({
        kind: bodies.length > 1 ? 'auto_split' : 'section',
        path_anchor: section.headingPath.length > 0 ? slugify(section.headingPath.join('-')) : null,
        heading_path: section.headingPath.length > 0 ? section.headingPath.join(' > ') : null,
        content_text: content,
        start_offset: section.startOffset,
        end_offset: section.endOffset,
        metadata: {
          chunker_version: opts.chunkerVersion,
          estimated_tokens: estimateTokens(content),
          split_index: index,
          split_count: bodies.length,
        },
      });
    }
  }

  // Merge tiny adjacent chunks under the same heading parent where cheap.
  const merged: typeof rawChunks = [];
  for (const chunk of rawChunks) {
    const prior = merged[merged.length - 1];
    const canMerge =
      prior &&
      estimateTokens(chunk.content_text) < opts.minTokens &&
      estimateTokens(`${prior.content_text}\n\n${chunk.content_text}`) <= opts.maxTokens;
    if (canMerge) {
      prior.content_text = `${prior.content_text}\n\n${chunk.content_text}`;
      prior.end_offset = chunk.end_offset ?? prior.end_offset;
      prior.metadata = {
        ...prior.metadata,
        merged: true,
        estimated_tokens: estimateTokens(prior.content_text),
      };
    } else {
      merged.push({ ...chunk });
    }
  }

  return merged.map((chunk, ordinal) => ({
    ...chunk,
    ordinal,
    path_anchor: chunk.path_anchor ? `${chunk.path_anchor}-${ordinal + 1}` : null,
    content_md5: md5(chunk.content_text),
  }));
}
