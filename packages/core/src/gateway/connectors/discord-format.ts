import { createHash } from 'node:crypto';

import type { APIAllowedMentions } from 'discord-api-types/v10';

export const DISCORD_MESSAGE_MAX_CHARACTERS = 2_000;
export const DISCORD_MESSAGE_MAX_CHUNKS = 8;

export interface DiscordFormattedMessage {
  chunks: string[];
  /** Full UTF-8 Markdown to attach when the bounded chat chunks overflow. */
  overflowMarkdown?: string;
}

/** Fresh mention policy for every Discord create and edit request. */
export function discordAllowedMentionsNone(): APIAllowedMentions {
  return { parse: [], users: [], roles: [], replied_user: false };
}

/** Deterministic Discord nonce (maximum 25 characters) for one output chunk. */
export function discordMessageNonce(messageId: string, chunkIndex: number): string {
  if (!messageId.trim()) throw new Error('Agor message ID is required for a Discord nonce');
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('Discord chunk index must be a non-negative safe integer');
  }
  return createHash('sha256')
    .update(`${messageId}\0${chunkIndex}`)
    .digest('base64url')
    .slice(0, 25);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function unicodeSlice(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join('');
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
}

/** Convert GFM tables to Discord-safe monospace or readable list fallbacks. */
export function normalizeDiscordTables(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      output.push(line);
      continue;
    }
    if (fence) {
      output.push(line);
      continue;
    }

    const separator = lines[index + 1];
    if (!line.includes('|') || !separator || !isTableSeparator(separator)) {
      output.push(line);
      continue;
    }

    const tableLines = [line, separator];
    let next = index + 2;
    while (next < lines.length && lines[next].includes('|') && lines[next].trim()) {
      tableLines.push(lines[next]);
      next += 1;
    }
    index = next - 1;

    const narrow = Math.max(...tableLines.map(unicodeLength)) <= 100;
    if (narrow) {
      output.push('```text', ...tableLines, '```');
      continue;
    }

    const headers = splitTableRow(tableLines[0]);
    const rows = tableLines.slice(2).map(splitTableRow);
    if (rows.length === 0) {
      output.push(`- ${headers.join(' · ')}`);
      continue;
    }
    for (const row of rows) {
      const fields = headers
        .map(
          (header, cellIndex) => `${header || `Column ${cellIndex + 1}`}: ${row[cellIndex] ?? ''}`
        )
        .join(' · ');
      output.push(`- ${fields}`);
    }
  }

  return output.join('\n');
}

interface MarkdownSegment {
  kind: 'code' | 'text';
  text: string;
  openingFence?: string;
  closingFence?: string;
}

function segmentMarkdown(markdown: string): MarkdownSegment[] {
  const lines = markdown.split('\n');
  const segments: MarkdownSegment[] = [];
  let textLines: string[] = [];
  const flushText = () => {
    const text = textLines.join('\n').trim();
    if (text) segments.push({ kind: 'text', text });
    textLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(`{3,}|~{3,})/.exec(lines[index]);
    if (!match) {
      if (!lines[index].trim()) flushText();
      else textLines.push(lines[index]);
      continue;
    }

    flushText();
    const marker = match[1][0];
    const minimumLength = match[1].length;
    const codeLines = [lines[index]];
    let closingFence: string | undefined;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      codeLines.push(line);
      const closing = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{${minimumLength},}\\s*$`).test(
        line
      );
      if (closing) {
        closingFence = line;
        break;
      }
    }
    const openingFence = codeLines.shift()!;
    if (closingFence) codeLines.pop();
    segments.push({
      kind: 'code',
      text: codeLines.join('\n'),
      openingFence,
      closingFence: closingFence ?? match[1],
    });
  }
  flushText();
  return segments;
}

function splitTextAtBoundary(text: string, maxCharacters: number): string[] {
  const remaining = Array.from(text);
  const chunks: string[] = [];
  while (remaining.length > maxCharacters) {
    let boundary = maxCharacters;
    const minimumPreferred = Math.floor(maxCharacters * 0.6);
    for (let index = maxCharacters; index >= minimumPreferred; index -= 1) {
      if (/\s/.test(remaining[index - 1] ?? '')) {
        boundary = index;
        break;
      }
    }
    chunks.push(remaining.splice(0, boundary).join('').trimEnd());
    while (remaining[0] && /\s/.test(remaining[0])) remaining.shift();
  }
  if (remaining.length > 0) chunks.push(remaining.join('').trimEnd());
  return chunks.filter(Boolean);
}

function splitSegment(segment: MarkdownSegment, maxCharacters: number): string[] {
  if (segment.kind === 'text') return splitTextAtBoundary(segment.text, maxCharacters);

  const opening = segment.openingFence ?? '```';
  const closing = segment.closingFence ?? '```';
  const wrapperCharacters = unicodeLength(opening) + unicodeLength(closing) + 2;
  const bodyLimit = maxCharacters - wrapperCharacters;
  if (bodyLimit < 1) throw new Error('Discord message limit is too small for a code fence');
  const bodies = splitTextAtBoundary(segment.text, bodyLimit);
  if (bodies.length === 0) return [`${opening}\n${closing}`];
  return bodies.map((body) => `${opening}\n${body}\n${closing}`);
}

/**
 * Render Discord Markdown into bounded message chunks.
 *
 * The splitter works over structural text/code/table segments, never slices a
 * Unicode surrogate pair, and closes/reopens fenced code across chunks. If the
 * chat-chunk cap is exceeded, callers receive the complete original Markdown
 * for a `.md` attachment rather than silently dropping content.
 */
export function formatDiscordMarkdown(
  markdown: string,
  options: { maxCharacters?: number; maxChunks?: number } = {}
): DiscordFormattedMessage {
  const maxCharacters = options.maxCharacters ?? DISCORD_MESSAGE_MAX_CHARACTERS;
  const maxChunks = options.maxChunks ?? DISCORD_MESSAGE_MAX_CHUNKS;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32) {
    throw new Error('Discord message limit must be an integer of at least 32 characters');
  }
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) {
    throw new Error('Discord message chunk limit must be a positive integer');
  }

  const original = markdown.replace(/\r\n/g, '\n').trim();
  if (!original) return { chunks: [] };
  const normalized = normalizeDiscordTables(original);
  const chunks: string[] = [];
  for (const segment of segmentMarkdown(normalized)) {
    for (const part of splitSegment(segment, maxCharacters)) {
      const previous = chunks.at(-1);
      const combined = previous ? `${previous}\n\n${part}` : part;
      if (previous && unicodeLength(combined) <= maxCharacters)
        chunks[chunks.length - 1] = combined;
      else chunks.push(part);
    }
  }

  if (chunks.length <= maxChunks) return { chunks };
  const notice = 'Response continued in the attached Markdown file.';
  const visible = maxChunks === 1 ? [notice] : [...chunks.slice(0, maxChunks - 1), notice];
  return { chunks: visible, overflowMarkdown: original };
}

/** Exposed for focused boundary tests without encouraging JS-number coercion. */
export function discordUnicodeLength(value: string): number {
  return unicodeLength(value);
}

/** Exposed for connector overflow previews. */
export function discordUnicodeSlice(value: string, start: number, end?: number): string {
  return unicodeSlice(value, start, end);
}
