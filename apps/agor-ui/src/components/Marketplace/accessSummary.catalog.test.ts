// @vitest-environment node
/**
 * `accessSummary` over every curated disclosure: the line above Connect must
 * be a real, whole-sentence prefix of what the entry discloses.
 */
import { loadCatalog } from '@agor/core/mcp-catalog';
import { describe, expect, it } from 'vitest';
import { accessSummary } from './catalogPresentation';

describe('accessSummary over the curated catalog', async () => {
  const entries = await loadCatalog();

  it.each(entries.map((entry) => [entry.name, entry.permission_disclosure] as const))(
    '%s',
    (_name, disclosure) => {
      const summary = accessSummary(disclosure);
      const full = disclosure.trim();
      expect(full.startsWith(summary)).toBe(true);
      // A whole sentence (or the whole statement), never a cut mid-word.
      expect(summary === full || /[.!?]$/.test(summary)).toBe(true);
      expect(summary.length >= 40 || summary === full).toBe(true);
      expect(summary).not.toMatch(/\b(?:Inc|Ltd|Co|Corp|etc|e\.g|i\.e|U\.S)\.$/);
    }
  );
});
