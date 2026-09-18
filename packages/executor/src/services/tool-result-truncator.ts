import type { MessagePatch, TranscriptTruncation } from '@agor/core/types';
import { isGeneratedDiff } from './generated-diff.js';

type TruncatorFn = (content: unknown, targetBytes: number) => unknown;

const HEAD_RATIO = 0.75;
const TAIL_RATIO = 0.15;

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

function truncateString(s: string, targetBytes: number): string {
  const headBytes = Math.floor(targetBytes * HEAD_RATIO);
  const tailBytes = Math.floor(targetBytes * TAIL_RATIO);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= targetBytes) return s;
  let headEnd = headBytes;
  let tailStart = buf.length - tailBytes;
  // Never split a UTF-8 code point into replacement characters.
  while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  while (tailStart < buf.length && (buf[tailStart] & 0xc0) === 0x80) tailStart += 1;
  const head = buf.subarray(0, headEnd).toString('utf8');
  const tail = buf.subarray(tailStart).toString('utf8');
  const removed = tailStart - headEnd;
  return `${head}\n\n[… truncated ${removed.toLocaleString()} bytes …]\n\n${tail}`;
}

function truncateJsonArray(arr: unknown[], targetBytes: number): unknown {
  const totalItems = arr.length;
  const kept: unknown[] = [];
  let size = 2; // []
  for (const item of arr) {
    const itemSize = byteSize(item) + 1; // comma
    if (size + itemSize > targetBytes && kept.length > 0) break;
    kept.push(item);
    size += itemSize;
  }
  if (kept.length < totalItems) {
    kept.push(`[… ${totalItems - kept.length} more items truncated …]`);
  }
  return kept;
}

function truncateLineOutput(text: string, targetBytes: number): string {
  const lines = text.split('\n');
  if (lines.length <= 20) return truncateString(text, targetBytes);
  const headCount = Math.max(10, Math.floor(lines.length * 0.6));
  const tailCount = Math.max(5, Math.floor(lines.length * 0.1));
  const head = lines.slice(0, headCount).join('\n');
  const tail = lines.slice(-tailCount).join('\n');
  const omitted = lines.length - headCount - tailCount;
  const candidate = `${head}\n\n[… ${omitted} lines omitted …]\n\n${tail}`;
  if (Buffer.byteLength(candidate, 'utf8') <= targetBytes) return candidate;
  return truncateString(text, targetBytes);
}

const bashTruncator: TruncatorFn = (content, targetBytes) => {
  if (typeof content === 'string') return truncateLineOutput(content, targetBytes);
  return genericTruncator(content, targetBytes);
};

const readTruncator: TruncatorFn = bashTruncator;

const grepTruncator: TruncatorFn = (content, targetBytes) => {
  if (typeof content === 'string') return truncateLineOutput(content, targetBytes);
  return genericTruncator(content, targetBytes);
};

function genericTruncator(content: unknown, targetBytes: number): unknown {
  if (typeof content === 'string') return truncateString(content, targetBytes);
  if (Array.isArray(content)) return truncateJsonArray(content, targetBytes);
  if (content !== null && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    const entries = Object.entries(obj).map(([k, v]) => ({ key: k, val: v, size: byteSize(v) }));
    entries.sort((a, b) => b.size - a.size);
    const result: Record<string, unknown> = {};
    let remaining = targetBytes - 2; // {}
    let didTruncate = false;
    for (const entry of entries) {
      const keyOverhead = Buffer.byteLength(JSON.stringify(entry.key), 'utf8') + 1; // :
      if (entry.size + keyOverhead <= remaining) {
        result[entry.key] = entry.val;
        remaining -= entry.size + keyOverhead + 1; // comma
      } else if (!didTruncate && remaining > keyOverhead + 50) {
        result[entry.key] = genericTruncator(entry.val, remaining - keyOverhead);
        remaining = 0;
        didTruncate = true;
      } else {
        result[entry.key] = `[truncated: ${entry.size.toLocaleString()} bytes]`;
      }
    }
    return result;
  }
  return `[truncated: ${byteSize(content).toLocaleString()} bytes]`;
}

const TOOL_TRUNCATORS: Record<string, TruncatorFn> = {
  Bash: bashTruncator,
  Read: readTruncator,
  Grep: grepTruncator,
  grep: grepTruncator,
  find: bashTruncator,
  'list-directory': bashTruncator,
};

/**
 * Project only persisted tool data, never provider/model arguments. The budget
 * is for the ENTIRE create/patch data object, including duplicated tool_uses,
 * preview, metadata and JSON escaping. Identity/authority and non-tool messages
 * are not disposable: if they alone exceed the budget the transport guard fails
 * closed. No files, caches or tenant lookups are involved here.
 */
export function projectMessageData<T extends MessagePatch>(data: T, budgetBytes: number): T {
  return projectMessage(data, budgetBytes, false);
}

function projectMessage<T extends MessagePatch>(
  data: T,
  budgetBytes: number,
  generatedOnly: boolean
): T {
  if (byteSize(data) <= budgetBytes) return data;

  const projected = { ...data };
  if (Array.isArray(data.content)) {
    projected.content = data.content.map((block) => ({ ...block }));
  }
  const toolUses = data.tool_uses?.map((use) => ({ ...use }));
  if (toolUses) projected.tool_uses = toolUses;

  type Owner = { transcript_truncation?: TranscriptTruncation; [key: string]: unknown };
  const candidates: {
    owners: Owner[];
    field: string;
    size: number;
    toolName?: string;
    generated?: boolean;
  }[] = [];
  const inputs = new Map<string, Owner[]>();
  const blocks = Array.isArray(projected.content) ? projected.content : [];
  const uses = [...blocks.filter((block) => block.type === 'tool_use'), ...(toolUses ?? [])];
  for (const use of uses) {
    if (use.input === undefined) continue;
    const id = String(use.id);
    const owners = inputs.get(id) ?? [];
    owners.push(use);
    inputs.set(id, owners);
  }
  for (const owners of inputs.values()) {
    candidates.push({
      owners,
      field: 'input',
      size: owners.reduce((sum, owner) => sum + byteSize(owner.input), 0),
    });
  }
  // Only tool payloads are lossy. Keep identity, status and error flags verbatim,
  // including provider-supplied truncation metadata.
  const protectedFields = new Set([
    'type',
    'id',
    'name',
    'tool_use_id',
    'status',
    'is_error',
    'truncated',
    'transcript_truncation',
    'input',
  ]);
  for (const block of blocks) {
    if (block.type !== 'tool_use' && block.type !== 'tool_result') continue;
    for (const [field, value] of Object.entries(block)) {
      if (protectedFields.has(field) || value === undefined) continue;
      const use = uses.find((use) => use.id === block.tool_use_id);
      candidates.push({
        owners: [block],
        field,
        generated: field === 'diff' && isGeneratedDiff(value),
        size: byteSize(value),
        toolName: typeof use?.name === 'string' ? use.name : undefined,
      });
    }
  }
  // Presentation is always disposable before original data, even when smaller.
  // Arbitrary provider fields (including unmarked "diff") stay in the original
  // fallback tier. Size only orders candidates within each retention tier.
  candidates.sort((a, b) => Number(!!b.generated) - Number(!!a.generated) || b.size - a.size);

  for (const { owners, field, size, toolName, generated } of candidates) {
    if (generatedOnly && !generated) continue;
    const total = byteSize(projected);
    if (total <= budgetBytes) break;
    const previous = owners.map((owner) => ({
      value: owner[field],
      truncation: owner.transcript_truncation,
    }));
    for (const owner of owners) {
      const originalBytes = byteSize(owner[field]);
      const original = owner[field];
      owner.transcript_truncation = {
        ...owner.transcript_truncation,
        [field]: {
          original_bytes: owner.transcript_truncation?.[field]?.original_bytes ?? originalBytes,
        },
      };
      if (field === 'input') {
        // No executable-looking partial arguments. Both copies of this tool's
        // input are replaced together, leaving the caller's objects untouched.
        owner.input = {
          notice: `[Tool input omitted from transcript: ${originalBytes} serialized bytes]`,
        };
      } else if (field === 'content') {
        const target = Math.max(0, size - (total - budgetBytes) - 256);
        const truncator = (toolName && TOOL_TRUNCATORS[toolName]) || genericTruncator;
        owner.content = target >= 200 ? truncator(original, target) : undefined;
        // Truncators are best-effort (escaping, huge array items, etc.). Measure
        // the actual wrapper again; omission is the deterministic fallback.
        if (owner.content === undefined || byteSize(projected) > budgetBytes) {
          owner.content = `[Tool result omitted — original size ${originalBytes} serialized bytes exceeded transport budget]`;
        }
      } else {
        // In particular, never retain a partial structuredPatch/files object
        // that a renderer could mistake for a complete diff.
        delete owner[field];
      }
    }
    // Markers themselves have a cost, especially for duplicated short inputs.
    // Only keep a projection if it actually reduces the full serialized data.
    if (byteSize(projected) >= total) {
      owners.forEach((owner, index) => {
        owner[field] = previous[index].value;
        if (previous[index].truncation) owner.transcript_truncation = previous[index].truncation;
        else delete owner.transcript_truncation;
      });
    }
  }
  return projected;
}

/** Bulk creates share one transport budget, not one budget per message. */
export function projectTranscriptData(
  data: MessagePatch | MessagePatch[],
  budgetBytes: number
): MessagePatch | MessagePatch[] {
  if (!Array.isArray(data)) return projectMessageData(data, budgetBytes);
  if (byteSize(data) <= budgetBytes) return data;
  const projected = [...data];
  const entries = data.map((message, index) => ({ index, size: byteSize(message) }));
  entries.sort((a, b) => b.size - a.size);
  // Bulk writes also exhaust generated enrichment across ALL messages before
  // touching originals in any message. The array wrapper counts in both passes.
  for (const generatedOnly of [true, false]) {
    for (const { index } of entries) {
      const total = byteSize(projected);
      if (total <= budgetBytes) break;
      const message = projected[index];
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      projected[index] = projectMessage(
        message,
        Math.max(0, budgetBytes - total + byteSize(message)),
        generatedOnly
      );
    }
  }
  return projected;
}
