/**
 * Tool Registry — Captures tool metadata for search-based discovery.
 *
 * When tool search is enabled, agents see only a few essential tools in
 * `tools/list` and discover the rest via `agor_search_tools`. All tools
 * remain registered and callable; only the listing is filtered.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

/** Tools always visible in `tools/list` even when search mode is enabled. */
const ALWAYS_VISIBLE = new Set([
  'agor_search_tools',
  'agor_sessions_get_current',
  'agor_sessions_spawn',
  'agor_sessions_prompt',
  'agor_worktrees_update',
]);

export class ToolRegistry {
  private tools: Map<string, ToolEntry> = new Map();

  register(entry: ToolEntry): void {
    this.tools.set(entry.name, entry);
  }

  get size(): number {
    return this.tools.size;
  }

  /** Return only the always-visible tools (for filtered tools/list). */
  getAlwaysVisible(): ToolEntry[] {
    const result: ToolEntry[] = [];
    for (const [name, entry] of this.tools) {
      if (ALWAYS_VISIBLE.has(name)) result.push(entry);
    }
    return result;
  }

  /** Search tools by keyword. Matches against name + description. */
  search(query: string, maxResults = 10): ToolEntry[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) {
      return Array.from(this.tools.values()).slice(0, maxResults);
    }

    const scored: Array<{ entry: ToolEntry; score: number }> = [];

    for (const entry of this.tools.values()) {
      const haystack = `${entry.name} ${entry.description}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score++;
      }
      if (score > 0) scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map((s) => s.entry);
  }
}
