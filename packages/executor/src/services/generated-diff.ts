import type { DiffEnrichment, TranscriptTruncation } from '@agor/core/types';

/** 250 KiB per complete generated diff, including its JSON wrapper and duplicates.
 * This is a preview limit, not reserved space: the full-message projector may
 * omit even a smaller diff to preserve original tool data under its own budget.
 */
export const GENERATED_DIFF_BUDGET_BYTES = 256_000;

// Executor-local provenance, not a provider-controlled field-name heuristic.
// Current handlers pass these diff objects by reference through message wrapper
// construction to the Feathers before hook. No payloads are retained by this set
// or serialized into an extra metadata field. Handler integration tests protect
// that route; any future clone/serialization boundary must carry provenance too.
const generatedDiffs = new WeakSet<object>();

export function isGeneratedDiff(value: unknown): boolean {
  return typeof value === 'object' && value !== null && generatedDiffs.has(value);
}

export function attachGeneratedDiff(
  block: { diff?: unknown; transcript_truncation?: TranscriptTruncation },
  diff: DiffEnrichment
): void {
  // Never replace a provider-original field, even one named "diff".
  if (block.diff !== undefined || block.transcript_truncation?.diff) return;
  const originalBytes = Buffer.byteLength(JSON.stringify(diff), 'utf8');
  if (Buffer.byteLength(JSON.stringify({ diff }), 'utf8') > GENERATED_DIFF_BUDGET_BYTES) {
    block.transcript_truncation = {
      ...block.transcript_truncation,
      diff: { original_bytes: originalBytes },
    };
    return;
  }
  generatedDiffs.add(diff);
  block.diff = diff;
}
