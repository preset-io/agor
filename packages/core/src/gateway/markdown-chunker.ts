/**
 * Deterministic, fence-aware Markdown chunking for provider message limits.
 *
 * Text is tokenized by code point so a cut never splits a surrogate pair. An
 * open code fence is closed at the end of a chunk and reopened (with its info
 * string) at the start of the next, so every chunk renders on its own.
 */

export interface MarkdownChunkOptions {
  /** Maximum rendered size of one chunk, in `measure` units. */
  limit: number;
  /** Size of a string; must be additive over code points (default: code points). */
  measure?: (value: string) => number;
  /** Provider label used in limit errors, e.g. "Discord". */
  label?: string;
}

interface FenceState {
  /** Exact info string from the opening fence, without the newline. */
  info: string;
}

interface ChunkToken {
  text: string;
  size: number;
  stateAfter: FenceState | null;
}

const FENCE_SUFFIX = '\n```';

export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** UTF-16 code units, the unit several providers (e.g. Teams) count. */
export function utf16Length(value: string): number {
  return value.length;
}

function fencePrefix(state: FenceState): string {
  return `\`\`\`${state.info}\n`;
}

function tokenize(text: string, measure: (value: string) => number): ChunkToken[] {
  const codePoints = Array.from(text);
  const tokens: ChunkToken[] = [];
  let state: FenceState | null = null;
  let offset = 0;
  const push = (value: string) =>
    tokens.push({ text: value, size: measure(value), stateAfter: state });
  while (offset < codePoints.length) {
    const isFence =
      codePoints[offset] === '`' &&
      codePoints[offset + 1] === '`' &&
      codePoints[offset + 2] === '`';
    if (!isFence) {
      push(codePoints[offset]);
      offset += 1;
      continue;
    }
    if (state) {
      state = null;
      push('```');
      offset += 3;
      continue;
    }
    const newlineOffset = codePoints.indexOf('\n', offset + 3);
    const infoEnd = newlineOffset === -1 ? codePoints.length : newlineOffset;
    const tokenEnd = newlineOffset === -1 ? codePoints.length : newlineOffset + 1;
    state = { info: codePoints.slice(offset + 3, infoEnd).join('') };
    push(codePoints.slice(offset, tokenEnd).join(''));
    offset = tokenEnd;
  }
  return tokens;
}

/** Split text deterministically without any chunk exceeding `limit`. */
export function chunkMarkdown(text: string, options: MarkdownChunkOptions): string[] {
  const { limit } = options;
  const measure = options.measure ?? codePointLength;
  const fenceError = `${options.label ?? 'Markdown'} chunk limit cannot accommodate a Markdown fence`;
  if (!Number.isInteger(limit) || limit < 32) {
    throw new Error(`${options.label ?? 'Markdown'} chunk limit is too small`);
  }
  if (text.length === 0) return [''];

  const suffixSize = measure(FENCE_SUFFIX);
  const rendered = (prefixSize: number, sourceSize: number, next: FenceState | null) =>
    prefixSize + sourceSize + (next ? suffixSize : 0);
  const tokens = tokenize(text, measure);
  const chunks: string[] = [];
  let state: FenceState | null = null;
  let tokenOffset = 0;

  while (tokenOffset < tokens.length) {
    const prefix = state ? fencePrefix(state) : '';
    const prefixSize = measure(prefix);
    if (prefixSize >= limit) throw new Error(fenceError);

    const startOffset = tokenOffset;
    let sourceSize = 0;
    let maxOffset = tokenOffset;
    let maxState: FenceState | null = state;
    while (maxOffset < tokens.length) {
      const token = tokens[maxOffset];
      if (rendered(prefixSize, sourceSize + token.size, token.stateAfter) > limit) break;
      sourceSize += token.size;
      maxOffset += 1;
      maxState = token.stateAfter;
    }
    if (maxOffset === startOffset) throw new Error(fenceError);

    // Prefer a readable cut after whitespace, but only at token boundaries and
    // only when the following token still fits with its full fence prefix.
    let softOffset = startOffset;
    let scanned = 0;
    for (let index = startOffset; index < maxOffset; index += 1) {
      const token = tokens[index];
      scanned += token.size;
      if ((token.text === '\n' || token.text === ' ') && scanned >= Math.floor(limit * 0.6)) {
        softOffset = index + 1;
      }
    }
    let endOffset = maxOffset;
    let nextState: FenceState | null = maxState;
    if (softOffset > startOffset && softOffset < maxOffset) {
      const candidateState = tokens[softOffset - 1].stateAfter;
      const candidatePrefix = candidateState ? measure(fencePrefix(candidateState)) : 0;
      const nextToken = tokens[softOffset];
      const nextFits =
        !nextToken || rendered(candidatePrefix, nextToken.size, nextToken.stateAfter) <= limit;
      if (nextFits) {
        endOffset = softOffset;
        nextState = candidateState;
      }
    }

    let source = '';
    let size = 0;
    for (let index = startOffset; index < endOffset; index += 1) {
      source += tokens[index].text;
      size += tokens[index].size;
    }
    if (rendered(prefixSize, size, nextState) > limit) throw new Error(fenceError);
    chunks.push(prefix + source + (nextState ? FENCE_SUFFIX : ''));
    state = nextState;
    tokenOffset = endOffset;
  }
  return chunks;
}
