/** Per-process reaction limits, matching Slack: one prompt per reaction per minute, three per thread per minute. */

const COOLDOWN_MS = 60_000;
const THREAD_WINDOW_MS = 60_000;
const THREAD_MAX = 3;
const MAX_TRACKED = 10_000;

export class TeamsReactionLimiter {
  private readonly cooldowns = new Map<string, number>();
  private readonly threads = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Admit one reaction, or null when either limit is spent; `release` undoes a reaction that was not admitted. */
  admit(reactionKey: string, threadKey: string): { release: () => void } | null {
    const now = this.now();
    this.evict(now);
    const cooldownUntil = this.cooldowns.get(reactionKey);
    if (cooldownUntil !== undefined && cooldownUntil > now) return null;
    const times = this.threads.get(threadKey) ?? [];
    if (times.length >= THREAD_MAX) return null;
    if (this.cooldowns.size >= MAX_TRACKED || this.threads.size >= MAX_TRACKED) return null;
    this.cooldowns.set(reactionKey, now + COOLDOWN_MS);
    this.threads.set(threadKey, [...times, now]);
    return {
      release: () => {
        if (this.cooldowns.get(reactionKey) === now + COOLDOWN_MS)
          this.cooldowns.delete(reactionKey);
        const live = [...(this.threads.get(threadKey) ?? [])];
        const index = live.indexOf(now);
        if (index >= 0) live.splice(index, 1);
        if (live.length) this.threads.set(threadKey, live);
        else this.threads.delete(threadKey);
      },
    };
  }

  private evict(now: number): void {
    for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
    for (const [key, times] of this.threads) {
      const live = times.filter((time) => time > now - THREAD_WINDOW_MS);
      if (live.length) this.threads.set(key, live);
      else this.threads.delete(key);
    }
  }
}
