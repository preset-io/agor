import type { GatewayProviderProbeLease } from '@agor/core/db';

export const DISCORD_PROVIDER_PROBE_LEASE_MS = 30_000;
export const DISCORD_PROVIDER_PROBE_RENEW_INTERVAL_MS = 5_000;
export const DISCORD_PROVIDER_PROBE_RENEW_TIMEOUT_MS = 10_000;
export const DISCORD_PROVIDER_PROBE_TOTAL_DEADLINE_MS = 3 * 60_000;
const DISCORD_PROVIDER_PROBE_TEARDOWN_WAIT_MS = 5_000;

export type GatewayProviderProbeAbortCode = 'probe_deadline_exceeded' | 'probe_ownership_lost';

export class GatewayProviderProbeAbortError extends Error {
  constructor(readonly code: GatewayProviderProbeAbortCode) {
    super(code);
    this.name = 'GatewayProviderProbeAbortError';
  }
}

interface GatewayProviderProbeRenewalRepository {
  renewProviderProbe(input: {
    channelId: GatewayProviderProbeLease['channel_id'];
    claimToken: string;
    generation: number;
    providerConfigGeneration: number;
    leaseDurationMs: number;
  }): Promise<GatewayProviderProbeLease | null>;
}

/**
 * Keeps one disabled-channel setup owner current using exact DB-time renewal.
 * Process time only bounds the whole HTTP probe; it is never ownership truth.
 */
export class GatewayProviderProbeHeartbeat {
  private readonly controller = new AbortController();
  private stopped = false;
  private renewTimer?: NodeJS.Timeout;
  private deadlineTimer?: NodeJS.Timeout;
  private renewal?: Promise<void>;
  private transitioning = false;

  constructor(
    private readonly repository: GatewayProviderProbeRenewalRepository,
    private lease: GatewayProviderProbeLease,
    private readonly options: {
      leaseMs?: number;
      renewIntervalMs?: number;
      renewTimeoutMs?: number;
      totalDeadlineMs?: number;
      teardownWaitMs?: number;
    } = {}
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.stopped || this.deadlineTimer || this.renewTimer || this.renewal) return;
    this.deadlineTimer = setTimeout(
      () => this.abort('probe_deadline_exceeded'),
      this.options.totalDeadlineMs ?? DISCORD_PROVIDER_PROBE_TOTAL_DEADLINE_MS
    );
    this.deadlineTimer.unref?.();
    this.scheduleRenewal();
  }

  private abort(code: GatewayProviderProbeAbortCode): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(new GatewayProviderProbeAbortError(code));
    }
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = undefined;
  }

  private scheduleRenewal(): void {
    if (this.stopped || this.signal.aborted || this.transitioning) return;
    this.renewTimer = setTimeout(() => {
      this.renewTimer = undefined;
      this.beginRenewal();
    }, this.options.renewIntervalMs ?? DISCORD_PROVIDER_PROBE_RENEW_INTERVAL_MS);
    this.renewTimer.unref?.();
  }

  private beginRenewal(): void {
    if (this.stopped || this.signal.aborted || this.renewal || this.transitioning) return;
    let timeout: NodeJS.Timeout | undefined;
    const renewalTimeoutMs = Math.min(
      this.options.renewTimeoutMs ?? DISCORD_PROVIDER_PROBE_RENEW_TIMEOUT_MS,
      (this.options.leaseMs ?? DISCORD_PROVIDER_PROBE_LEASE_MS) / 2
    );
    const repositoryRenewal = this.repository.renewProviderProbe({
      channelId: this.lease.channel_id,
      claimToken: this.lease.claim_token,
      generation: this.lease.generation,
      providerConfigGeneration: this.lease.provider_config_generation,
      leaseDurationMs: this.options.leaseMs ?? DISCORD_PROVIDER_PROBE_LEASE_MS,
    });
    const renewal = Promise.race([
      repositoryRenewal,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), renewalTimeoutMs);
        timeout.unref?.();
      }),
    ])
      .then((renewed) => {
        if (!renewed) this.abort('probe_ownership_lost');
      })
      .catch(() => this.abort('probe_ownership_lost'))
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        if (this.renewal === renewal) this.renewal = undefined;
        this.scheduleRenewal();
      });
    this.renewal = renewal;
  }

  abortCode(): GatewayProviderProbeAbortCode | undefined {
    const reason = this.signal.reason;
    return reason instanceof GatewayProviderProbeAbortError ? reason.code : undefined;
  }

  /**
   * Serialize an atomic database transition that changes the config generation
   * while retaining this exact probe token/generation. Renewal is paused so an
   * old-generation heartbeat cannot race the transition and self-fence.
   */
  async transitionProviderConfigGeneration(
    transition: () => Promise<number | null>
  ): Promise<boolean> {
    if (this.stopped || this.signal.aborted || this.transitioning) return false;
    this.transitioning = true;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = undefined;
    try {
      if (this.renewal) await this.renewal;
      if (this.stopped || this.signal.aborted) return false;
      const providerConfigGeneration = await transition();
      if (!providerConfigGeneration || this.stopped || this.signal.aborted) return false;
      this.lease = { ...this.lease, provider_config_generation: providerConfigGeneration };
      return true;
    } catch (error) {
      this.abort('probe_ownership_lost');
      throw error;
    } finally {
      this.transitioning = false;
      this.scheduleRenewal();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.renewTimer = undefined;
    this.deadlineTimer = undefined;
    const renewal = this.renewal;
    if (!renewal) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      renewal,
      new Promise<void>((resolve) => {
        timer = setTimeout(
          resolve,
          this.options.teardownWaitMs ?? DISCORD_PROVIDER_PROBE_TEARDOWN_WAIT_MS
        );
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
