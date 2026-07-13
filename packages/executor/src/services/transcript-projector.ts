export const EXECUTOR_REQUEST_DATA_BUDGET_BYTES = 800_000;

const TRANSCRIPT_PROJECTION_MARKER = '\n\n[Middle omitted from transcript storage]\n\n';

interface TranscriptRequestContext {
  path: string;
  method: string;
}

interface Candidate {
  messageIndex: number | null;
  blockIndex: number;
  encounterOrder: number;
  source: string;
  originalContentBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function serializeRequest(data: unknown, context: TranscriptRequestContext): string {
  try {
    const serialized = JSON.stringify(data);
    if (serialized === undefined) throw new Error('not serializable');
    return serialized;
  } catch {
    throw new Error(
      `Transcript request data could not be serialized (size unavailable; budget ${EXECUTOR_REQUEST_DATA_BUDGET_BYTES} bytes; ${context.path}.${context.method})`
    );
  }
}

function requestBytes(data: unknown, context: TranscriptRequestContext): number {
  return byteLength(serializeRequest(data, context));
}

function contentSource(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) && !isRecord(content)) return undefined;
  const serialized = JSON.stringify(content);
  return serialized === undefined ? undefined : serialized;
}

function takeHead(source: string, budget: number): string {
  let end = 0;
  let used = 0;
  for (const codePoint of source) {
    const size = byteLength(codePoint);
    if (used + size > budget) break;
    used += size;
    end += codePoint.length;
  }
  return source.slice(0, end);
}

function takeTail(source: string, budget: number): string {
  let start = source.length;
  let used = 0;
  while (start > 0) {
    let nextStart = start - 1;
    const codeUnit = source.charCodeAt(nextStart);
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && nextStart > 0) {
      const previous = source.charCodeAt(nextStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) nextStart -= 1;
    }
    const codePoint = source.slice(nextStart, start);
    const size = byteLength(codePoint);
    if (used + size > budget) break;
    used += size;
    start = nextStart;
  }
  return source.slice(start);
}

function previewContent(source: string, byteBudget: number): string {
  const markerBytes = byteLength(TRANSCRIPT_PROJECTION_MARKER);
  const remaining = Math.max(0, byteBudget - markerBytes);
  const headBudget = Math.floor(remaining / 2);
  const tailBudget = remaining - headBudget;
  return `${takeHead(source, headBudget)}${TRANSCRIPT_PROJECTION_MARKER}${takeTail(source, tailBudget)}`;
}

function collectCandidates(data: unknown): Candidate[] {
  const messages = Array.isArray(data) ? data : [data];
  const candidates: Candidate[] = [];
  let encounterOrder = 0;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (
        !isRecord(block) ||
        block.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string'
      ) {
        continue;
      }
      const source = contentSource(block.content);
      if (source === undefined) continue;
      candidates.push({
        messageIndex: Array.isArray(data) ? messageIndex : null,
        blockIndex,
        encounterOrder,
        source,
        originalContentBytes: byteLength(source),
      });
      encounterOrder += 1;
    }
  }

  return candidates.sort(
    (left, right) =>
      right.originalContentBytes - left.originalContentBytes ||
      left.encounterOrder - right.encounterOrder
  );
}

function replaceCandidate(data: unknown, candidate: Candidate, content: string): unknown {
  const message =
    candidate.messageIndex === null ? data : (data as unknown[])[candidate.messageIndex];
  if (!isRecord(message) || !Array.isArray(message.content)) return data;
  const block = message.content[candidate.blockIndex];
  if (!isRecord(block)) return data;

  const nextBlock = {
    ...block,
    content,
    transcript_projection: {
      truncated: true as const,
      original_content_bytes: candidate.originalContentBytes,
      persisted_content_bytes: byteLength(content),
    },
  };
  const nextContent = message.content.slice();
  nextContent[candidate.blockIndex] = nextBlock;
  const nextMessage = { ...message, content: nextContent };

  if (candidate.messageIndex === null) return nextMessage;
  const nextData = (data as unknown[]).slice();
  nextData[candidate.messageIndex] = nextMessage;
  return nextData;
}

export function projectTranscriptRequestData(
  data: unknown,
  context: TranscriptRequestContext
): unknown {
  let projected = data;
  let projectedBytes = requestBytes(projected, context);
  if (projectedBytes <= EXECUTOR_REQUEST_DATA_BUDGET_BYTES) return data;

  for (const candidate of collectCandidates(data)) {
    const markerOnly = replaceCandidate(
      projected,
      candidate,
      previewContent(candidate.source, byteLength(TRANSCRIPT_PROJECTION_MARKER))
    );
    const markerOnlyBytes = requestBytes(markerOnly, context);

    if (markerOnlyBytes <= EXECUTOR_REQUEST_DATA_BUDGET_BYTES) {
      let low = byteLength(TRANSCRIPT_PROJECTION_MARKER);
      let high = Math.max(low, candidate.originalContentBytes - 1);
      let best = markerOnly;

      while (low <= high) {
        const midpoint = Math.floor((low + high) / 2);
        const attempt = replaceCandidate(
          projected,
          candidate,
          previewContent(candidate.source, midpoint)
        );
        if (requestBytes(attempt, context) <= EXECUTOR_REQUEST_DATA_BUDGET_BYTES) {
          best = attempt;
          low = midpoint + 1;
        } else {
          high = midpoint - 1;
        }
      }

      return best;
    }

    if (markerOnlyBytes < projectedBytes) {
      projected = markerOnly;
      projectedBytes = markerOnlyBytes;
    }
  }

  projectedBytes = requestBytes(projected, context);
  throw new Error(
    `Transcript request data is ${projectedBytes} bytes, exceeding the ${EXECUTOR_REQUEST_DATA_BUDGET_BYTES}-byte budget (${context.path}.${context.method})`
  );
}
