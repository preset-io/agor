/** Copy for the transcript's live status lines. Strings follow the transcript design reference. */

/** "12s", "1m 12s", "1h 2m". Never "0s": anything that happened took at least a second. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(1, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** The live thinking label escalates with time, then stops at the last step. */
export function thinkingLabel(seconds: number): string {
  if (seconds >= 60) return 'Almost done thinking…';
  if (seconds >= 45) return 'Thinking some more…';
  if (seconds >= 30) return 'Thinking more…';
  if (seconds >= 15) return 'Still thinking…';
  return 'Thinking…';
}

/** Finished thinking. Without both timestamps the duration is unknown, not zero. */
export function thoughtForLabel(startedAt?: number, endedAt?: number): string {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) {
    return 'Thought for a while';
  }
  return `Thought for ${formatElapsed((endedAt - startedAt) / 1000)}`;
}

/** The step the working line names, without its timer. `tool` is the one running or awaiting approval. */
export function workingStep({
  awaiting,
  tool,
}: {
  awaiting?: 'approval' | 'input';
  tool?: string;
}): string {
  if (awaiting === 'approval')
    return tool ? `Waiting for approval · ${tool}` : 'Waiting for approval';
  if (awaiting === 'input') return 'Asked a question';
  if (tool) return `Running: ${tool}`;
  return 'Working…';
}
