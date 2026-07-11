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
  private forceExitTimer?: ReturnType<typeof setTimeout>;
  private exitIssued = false;

  constructor(private readonly options: ExecutorShutdownOptions) {}

  get requested(): boolean {
    return this.shutdownPromise !== undefined;
  }

  trigger(signal: string): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    let resolveShutdown!: () => void;
    let rejectShutdown!: (error: unknown) => void;
    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });

    this.options.log?.(`[executor] Received ${signal}, shutting down...`);

    // Arm the executor-owned bound before abort handlers or daemon writes can wait.
    this.forceExitTimer = setTimeout(() => {
      this.exit(0);
    }, this.options.forceExitTimeoutMs ?? DEFAULT_FORCE_EXIT_TIMEOUT_MS);
    this.forceExitTimer.unref?.();

    const wasRunning = this.options.isRunning();
    if (wasRunning) {
      this.options.abortController.abort();
    }

    void this.finishTrigger(wasRunning).then(resolveShutdown, rejectShutdown);
    return this.shutdownPromise;
  }

  /** Exit after normal SDK unwind and runtime finalization complete. */
  async finishGracefully(): Promise<boolean> {
    if (!this.shutdownPromise) return false;

    await this.shutdownPromise;
    this.clearForceExitTimer();
    this.exit(0);
    return true;
  }

  private async finishTrigger(wasRunning: boolean): Promise<void> {
    await this.options.markStopped();

    if (!wasRunning) {
      this.clearForceExitTimer();
      this.exit(0);
    }
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
