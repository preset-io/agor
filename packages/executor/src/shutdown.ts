const DEFAULT_FORCE_EXIT_TIMEOUT_MS = 3_000;

export interface ExecutorShutdownOptions {
  abortController: AbortController;
  isRunning: () => boolean;
  markStopped: () => Promise<void>;
  exit?: (code: number) => void;
  forceExitTimeoutMs?: number;
  log?: (message: string) => void;
}

/** Owns the executor's signal-driven shutdown from first trigger through exit. */
export class ExecutorShutdown {
  private shutdownPromise?: Promise<void>;
  private settlePromise?: Promise<void>;
  private resolveShutdown?: () => void;
  private rejectShutdown?: (error: unknown) => void;
  private forceExitTimer?: ReturnType<typeof setTimeout>;
  private exitIssued = false;
  private exitCode = 0;
  private markStopped = false;

  constructor(private readonly options: ExecutorShutdownOptions) {}

  get requested(): boolean {
    return this.shutdownPromise !== undefined;
  }

  trigger(signal: string): Promise<void> {
    return this.requestShutdown(`Received ${signal}`, true, 0);
  }

  /** Stop local work after the daemon lease is lost without rewriting FAILED as STOPPED. */
  loseLease(): Promise<void> {
    return this.requestShutdown('Executor heartbeat lease lost', false, 1);
  }

  private requestShutdown(message: string, markStopped: boolean, exitCode: number): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.exitCode = exitCode;
    this.markStopped = markStopped;

    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      this.resolveShutdown = resolve;
      this.rejectShutdown = reject;
    });

    this.options.log?.(`[executor] ${message}, shutting down...`);

    // Arm the executor-owned bound before abort handlers or daemon writes can wait.
    this.forceExitTimer = setTimeout(() => {
      this.exit(this.exitCode);
    }, this.options.forceExitTimeoutMs ?? DEFAULT_FORCE_EXIT_TIMEOUT_MS);
    this.forceExitTimer.unref?.();

    const wasRunning = this.options.isRunning();
    if (wasRunning) {
      this.options.abortController.abort();
    }

    if (!wasRunning) void this.settle();
    return this.shutdownPromise;
  }

  /** Exit after normal SDK unwind and runtime finalization complete. */
  async finishGracefully(): Promise<boolean> {
    if (!this.shutdownPromise) return false;

    await this.settle();
    return true;
  }

  private settle(): Promise<void> {
    if (this.settlePromise) return this.settlePromise;
    this.settlePromise = (async () => {
      if (this.markStopped) await this.options.markStopped();
      this.clearForceExitTimer();
      this.exit(this.exitCode);
    })();
    void this.settlePromise.then(this.resolveShutdown, this.rejectShutdown);
    return this.settlePromise;
  }

  private clearForceExitTimer(): void {
    if (this.forceExitTimer) clearTimeout(this.forceExitTimer);
    this.forceExitTimer = undefined;
  }

  private exit(code: number): void {
    if (this.exitIssued) return;
    this.exitIssued = true;
    (this.options.exit ?? process.exit)(code);
  }
}
