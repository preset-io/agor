import { EXECUTOR_REQUEST_DATA_BUDGET_BYTES } from './feathers-client.js';

export interface ContentBlock {
  type: string;
  tool_use_id?: string;
  content?: unknown;
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface ToolUseRef {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TruncationResult {
  blocks: ContentBlock[];
  truncated: boolean;
  truncatedTools: string[];
}

type TruncatorFn = (content: unknown, targetBytes: number) => unknown;

const HEAD_RATIO = 0.75;
const TAIL_RATIO = 0.15;

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateString(s: string, targetBytes: number): string {
  const headBytes = Math.floor(targetBytes * HEAD_RATIO);
  const tailBytes = Math.floor(targetBytes * TAIL_RATIO);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= targetBytes) return s;
  const head = buf.subarray(0, headBytes).toString('utf8');
  const tail = buf.subarray(buf.length - tailBytes).toString('utf8');
  const removed = buf.length - headBytes - tailBytes;
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
    for (const entry of entries) {
      const keyOverhead = Buffer.byteLength(JSON.stringify(entry.key), 'utf8') + 1; // :
      if (entry.size + keyOverhead <= remaining) {
        result[entry.key] = entry.val;
        remaining -= entry.size + keyOverhead + 1; // comma
      } else if (remaining > keyOverhead + 50) {
        result[entry.key] = genericTruncator(entry.val, remaining - keyOverhead);
        break;
      } else {
        result[entry.key] = `[truncated: ${entry.size.toLocaleString()} bytes]`;
        break;
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

function resolveToolName(
  block: ContentBlock,
  allBlocks: ContentBlock[],
  toolUses: ToolUseRef[] | undefined
): string | undefined {
  const toolUseId = block.tool_use_id;
  if (!toolUseId) return undefined;
  if (toolUses) {
    const match = toolUses.find((t) => t.id === toolUseId);
    if (match) return match.name;
  }
  const useBlock = allBlocks.find((b) => b.type === 'tool_use' && b.id === toolUseId);
  if (useBlock?.name && typeof useBlock.name === 'string') return useBlock.name;
  return undefined;
}

function truncateToolResultBlock(
  block: ContentBlock,
  toolName: string | undefined,
  targetBytes: number
): ContentBlock {
  const truncator = (toolName && TOOL_TRUNCATORS[toolName]) || genericTruncator;
  const truncatedContent = truncator(block.content, targetBytes);
  return { ...block, content: truncatedContent };
}

export function truncateContentIfNeeded(
  contentBlocks: ContentBlock[],
  toolUses: ToolUseRef[] | undefined,
  budgetBytes: number = EXECUTOR_REQUEST_DATA_BUDGET_BYTES
): TruncationResult {
  const totalSize = byteSize(contentBlocks);
  if (totalSize <= budgetBytes) {
    return { blocks: contentBlocks, truncated: false, truncatedTools: [] };
  }

  const blocks = contentBlocks.map((b) => ({ ...b }));
  const truncatedTools: string[] = [];

  const toolResultIndices = blocks
    .map((b, i) => ({ block: b, index: i, size: byteSize(b) }))
    .filter((e) => e.block.type === 'tool_result')
    .sort((a, b) => b.size - a.size);

  for (const entry of toolResultIndices) {
    const currentTotal = byteSize(blocks);
    if (currentTotal <= budgetBytes) break;

    const toolName = resolveToolName(entry.block, blocks, toolUses);
    const excess = currentTotal - budgetBytes;
    const currentBlockSize = byteSize(blocks[entry.index]);
    const targetBlockSize = Math.max(200, currentBlockSize - excess - 100);

    blocks[entry.index] = truncateToolResultBlock(blocks[entry.index], toolName, targetBlockSize);
    if (toolName) truncatedTools.push(toolName);
    else truncatedTools.push('unknown');
  }

  if (byteSize(blocks) > budgetBytes) {
    for (const entry of toolResultIndices) {
      if (byteSize(blocks) <= budgetBytes) break;
      const toolName = resolveToolName(entry.block, blocks, toolUses);
      blocks[entry.index] = {
        ...blocks[entry.index],
        content: `[Tool result omitted — original size ${entry.size.toLocaleString()} bytes exceeded transport budget]`,
      };
      if (toolName && !truncatedTools.includes(toolName)) truncatedTools.push(toolName);
    }
  }

  return { blocks, truncated: true, truncatedTools };
}
