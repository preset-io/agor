export const AUTO_ZONE_INTERACTION_DEFER_MS = 60_000;

/**
 * One rolling timer per Auto Zone. Calling `defer` again replaces the previous
 * deadline, so continued interaction can never inherit an older timeout.
 */
export class AutoZoneDeferral {
  private readonly deadlines = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  defer(zoneId: string, onReady: () => void): void {
    this.deadlines.set(zoneId, Date.now() + AUTO_ZONE_INTERACTION_DEFER_MS);
    this.schedule(zoneId, onReady);
  }

  schedule(zoneId: string, onReady: () => void, minimumDelayMs = 0): void {
    const existing = this.timers.get(zoneId);
    if (existing) clearTimeout(existing);

    const now = Date.now();
    const deadline = this.deadlines.get(zoneId) ?? now;
    const delay = Math.max(minimumDelayMs, deadline - now, 0);
    const timer = setTimeout(() => {
      this.timers.delete(zoneId);
      const remaining = (this.deadlines.get(zoneId) ?? 0) - Date.now();
      if (remaining > 0) {
        this.schedule(zoneId, onReady);
        return;
      }
      this.deadlines.delete(zoneId);
      onReady();
    }, delay);
    this.timers.set(zoneId, timer);
  }

  cancel(zoneId: string): void {
    const timer = this.timers.get(zoneId);
    if (timer) clearTimeout(timer);
    this.timers.delete(zoneId);
    this.deadlines.delete(zoneId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.deadlines.clear();
  }
}
