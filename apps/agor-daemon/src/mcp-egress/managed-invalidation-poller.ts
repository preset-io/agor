import { randomInt } from 'node:crypto';
import { MCP_OAUTH_LIMITS } from '@agor/core/types';

/**
 * One runtime-owned poll loop, never a refresh or use-authorization renewer.
 * `synchronize` is the authenticated worker/DB adapter: it must commit each
 * page's invalidations before advancing its cell-bound cursor, and finish a
 * full authorized snapshot on a gap. It may not treat a failed read as empty.
 * The adapter owns canonical wire/store types, not this scheduling layer.
 */
export class ManagedInvalidationPoller {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: AbortController;
  private running = false;

  constructor(
    private readonly options: {
      synchronize: (signal: AbortSignal) => Promise<void>;
      /** Closed nonsecret event only: never log a worker response/exception. */
      onUnavailable?: () => void;
      jitterMs?: () => number;
      monotonicNow?: () => number;
    }
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.active?.abort();
  }

  private async poll(): Promise<void> {
    if (!this.running || this.active) return;
    const now = this.options.monotonicNow ?? (() => performance.now());
    const started = now();
    const controller = new AbortController();
    this.active = controller;
    const timeout = setTimeout(() => controller.abort(), MCP_OAUTH_LIMITS.recovery_timeout_ms);
    timeout.unref?.();
    try {
      await this.options.synchronize(controller.signal);
    } catch {
      if (this.running) this.options.onUnavailable?.();
      // Outage never clears a cursor/watermark or extends an authorization.
    } finally {
      clearTimeout(timeout);
      this.active = undefined;
      if (this.running) {
        const proposed = (
          this.options.jitterMs ?? (() => randomInt(0, MCP_OAUTH_LIMITS.jitter_ms + 1))
        )();
        const jitter = Number.isFinite(proposed)
          ? Math.min(MCP_OAUTH_LIMITS.jitter_ms, Math.max(0, proposed))
          : 0;
        this.timer = setTimeout(
          () => void this.poll(),
          Math.max(0, started + MCP_OAUTH_LIMITS.poll_ms + jitter - now())
        );
        this.timer.unref?.();
      }
    }
  }
}
