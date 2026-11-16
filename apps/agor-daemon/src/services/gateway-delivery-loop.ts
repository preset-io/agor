/**
 * Shared loop and failure helpers for provider gateway workers.
 *
 * A loop discovers due work ids under a named system capability (or one
 * fixed tenant), fans them out round-robin by tenant with bounded concurrency,
 * runs each lane's items serially, and purges terminal rows per tenant.
 * Provider-specific delivery, fencing, and outcome rules stay in each worker.
 */

import {
  runWithSystemDatabaseScope,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  type SystemDatabase,
  type SystemDatabaseCapability,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import { gatewayFailureCode } from '@agor/core/gateway';

/** Interleave refs across tenants so one busy tenant cannot starve the rest. */
export function fairOrderByTenant<T extends { tenant_id: string }>(refs: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const ref of refs) {
    const group = groups.get(ref.tenant_id) ?? [];
    group.push(ref);
    groups.set(ref.tenant_id, group);
  }
  const ordered: T[] = [];
  while (groups.size > 0) {
    for (const [tenantId, group] of groups) {
      const next = group.shift();
      if (next) ordered.push(next);
      if (group.length === 0) groups.delete(tenantId);
    }
  }
  return ordered;
}

/** A worker-decided outcome: cancel, dead-letter, or retry with backoff. */
export class DeliveryControlError extends Error {
  constructor(
    readonly code: string,
    readonly terminal: 'canceled' | 'dead_letter' | 'retry',
    readonly retryAfterMs?: number
  ) {
    super(code);
    this.name = 'DeliveryControlError';
  }
}

export function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  const status = record.status ?? record.statusCode ?? record.code;
  return typeof status === 'number' ? status : undefined;
}

function parseHeaderValue(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as Record<string, unknown> & { get?: (name: string) => unknown };
  if (typeof h.get === 'function') {
    const val = h.get(name);
    if (val !== undefined && val !== null) return val;
    const lowerVal = h.get(name.toLowerCase());
    if (lowerVal !== undefined && lowerVal !== null) return lowerVal;
  }
  const targetLower = name.toLowerCase();
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() === targetLower) {
      return h[key];
    }
  }
  return undefined;
}

function parseSecondsOrDate(value: unknown, now: number): number | undefined {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) {
      return Math.round(value * 1_000);
    }
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    // Strict non-negative integer or decimal seconds
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const sec = Number(trimmed);
      if (Number.isFinite(sec) && sec >= 0) {
        return Math.round(sec * 1_000);
      }
      return undefined;
    }
    // Reject negative numbers or numeric strings with signs/garbage (e.g. "-10", "60abc")
    if (/^[+-]|\d+[a-zA-Z]/.test(trimmed)) {
      return undefined;
    }
    // Attempt HTTP-date parse (must contain alphabetic day/month per RFC 7231)
    if (/[a-zA-Z]/.test(trimmed)) {
      const dateMs = Date.parse(trimmed);
      if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - now);
      }
    }
    return undefined;
  }
  return undefined;
}

function parseEpochSeconds(value: unknown, now: number): number | undefined {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0) {
      return Math.max(0, Math.round(value * 1_000 - now));
    }
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const epochSec = Number(trimmed);
      if (Number.isFinite(epochSec) && epochSec >= 0) {
        return Math.max(0, Math.round(epochSec * 1_000 - now));
      }
    }
    return undefined;
  }
  return undefined;
}

export function retryAfterMs(error: unknown, now: number = Date.now()): number | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;

  // 1. Direct millisecond properties
  const directMs = record.retry_after_ms ?? record.retryAfterMs;
  if (typeof directMs === 'number' && Number.isFinite(directMs) && directMs >= 0) {
    return directMs;
  }

  // 2. Direct second properties
  const directSec = record.retry_after ?? record.retryAfter;
  if (typeof directSec === 'number' && Number.isFinite(directSec) && directSec >= 0) {
    return Math.round(directSec * 1_000);
  }

  // 3. Response headers (e.g. Octokit RequestError.response.headers or fetch Headers)
  const respRecord = record.response as Record<string, unknown> | undefined;
  const headers = respRecord?.headers ?? record.headers;
  if (headers) {
    // 3a. Retry-After header (seconds or HTTP-date)
    const retryAfterVal = parseHeaderValue(headers, 'retry-after');
    const retryAfterMsVal = parseSecondsOrDate(retryAfterVal, now);
    if (retryAfterMsVal !== undefined) return retryAfterMsVal;

    // 4. X-RateLimit-Reset header (Unix epoch seconds)
    const resetVal = parseHeaderValue(headers, 'x-ratelimit-reset');
    const resetMsVal = parseEpochSeconds(resetVal, now);
    if (resetMsVal !== undefined) return resetMsVal;
  }

  return undefined;
}

/** A 4xx other than timeout/conflict/too-early/rate-limit proves a final rejection. */
export function isDefinitiveProviderFailure(error: unknown): boolean {
  const status = providerStatus(error);
  return (
    status !== undefined && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)
  );
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const BACKOFF_MAX_RATE_LIMIT_MS = 10 * 60_000;

export function boundedBackoff(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return Math.min(BACKOFF_MAX_RATE_LIMIT_MS, Math.max(0, retryAfter));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(attempt - 1, 8)));
}

/** Discover due refs for one fixed tenant or, across tenants, under a named capability. */
export function discoverDueDeliveryRefs<T>(
  db: TenantScopeAwareDatabase,
  input: {
    tenantId?: string;
    label: string;
    capability: SystemDatabaseCapability;
    find: (scoped: TenantScopedDatabase | SystemDatabase) => Promise<T[]>;
  }
): Promise<T[]> {
  if (input.tenantId) return runWithTenantDatabaseScope(db, input.tenantId, input.find);
  return runWithSystemDatabaseScope(db, input.label, input.find, {
    capability: input.capability,
  });
}

/**
 * Run one provider call under a live, renewed claim and a hard deadline below
 * the lease. The signal aborts the request when the deadline passes.
 */
export async function boundedProviderCall<C, T>(input: {
  claim: C;
  renew: (claim: C) => Promise<C>;
  timeoutMs: number;
  timeoutError: () => Error;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<{ claim: C; result: T }> {
  let current = await input.renew(input.claim);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      input.operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = input.timeoutError();
          controller.abort(error);
          reject(error);
        }, input.timeoutMs);
      }),
    ]);
    current = await input.renew(current);
    return { claim: current, result };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface GatewayDeliveryLoopOptions<Ref extends { tenant_id: string }> {
  /** Log prefix without brackets, e.g. `distributed-work.discord-message-delivery`. */
  area: string;
  tenantId?: string;
  scanBatchSize: number;
  maxConcurrency: number;
  shutdownTimeoutMs: number;
  recoveryIntervalMs: number;
  /** When set, empty scans double the recovery interval up to this bound. */
  maxIdleDelayMs?: number;
  random: () => number;
  discover: (limit: number) => Promise<Ref[]>;
  /** Serial lane within a tenant; refs sharing one never run concurrently. */
  lane: (ref: Ref) => string;
  process: (ref: Ref) => Promise<void>;
  /** Per-tenant retention pass, run inside that tenant's context after each scan. */
  purge?: () => Promise<unknown>;
}

/** All-daemon, tenant-fair discovery/claim loop with serial lanes. */
export class GatewayDeliveryLoop<Ref extends { tenant_id: string }> {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private rescan = false;
  private idleScans = 0;
  private readonly activeWork = new Set<Promise<unknown>>();
  private readonly threadTails = new Map<string, Promise<void>>();
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly options: GatewayDeliveryLoopOptions<Ref>) {
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error(`${options.area} concurrency must be a positive integer`);
    }
    if (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 1) {
      throw new Error(`${options.area} shutdown timeout must be a positive integer`);
    }
  }

  start(): void {
    if (this.timer || this.running) return;
    this.stopped = false;
    this.schedule(Math.floor(this.options.random() * 1_000));
    console.log(`[${this.options.area}] event="loop_started"`);
  }

  /** Scan soon on this replica, e.g. after a local commit made work due. */
  wake(): void {
    if (this.stopped || (!this.timer && !this.running)) return;
    this.idleScans = 0;
    if (this.running) {
      this.rescan = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    console.log(`[${this.options.area}] event="loop_stopped"`);
    this.drainPromise = this.drainActiveWork();
    return this.drainPromise;
  }

  private async drainActiveWork(): Promise<void> {
    if (this.activeWork.size === 0) return;
    const active = Promise.allSettled([...this.activeWork]).then(() => undefined);
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      active,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.options.shutdownTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (this.activeWork.size > 0) {
      console.warn(`[${this.options.area}] event="drain_timeout" active=${this.activeWork.size}`);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runLoopIteration();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runLoopIteration(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.rescan = false;
    try {
      const count = await this.checkOnce();
      if (this.rescan || count >= this.options.scanBatchSize) {
        this.idleScans = 0;
        this.schedule(this.rescan ? 0 : 100);
      } else {
        this.schedule(this.recoveryDelay(count === 0));
      }
    } catch (error) {
      console.warn(`[${this.options.area}] event=scan_failed code=${gatewayFailureCode(error)}`);
      this.schedule(this.recoveryDelay(true));
    } finally {
      this.running = false;
    }
  }

  private recoveryDelay(idle: boolean): number {
    const { maxIdleDelayMs, recoveryIntervalMs } = this.options;
    if (maxIdleDelayMs === undefined) return recoveryIntervalMs;
    this.idleScans = idle ? Math.min(this.idleScans + 1, 6) : 0;
    return Math.min(maxIdleDelayMs, recoveryIntervalMs * 2 ** this.idleScans);
  }

  /** One bounded discovery/claim pass, exposed for focused tests. */
  async checkOnce(): Promise<number> {
    const work = this.checkOnceInternal();
    this.activeWork.add(work);
    try {
      return await work;
    } finally {
      this.activeWork.delete(work);
    }
  }

  private async checkOnceInternal(): Promise<number> {
    const refs = await this.options.discover(this.options.scanBatchSize);
    const tenants = new Set<string>(this.options.tenantId ? [this.options.tenantId] : []);
    const orderedRefs = fairOrderByTenant(refs);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(this.options.maxConcurrency, orderedRefs.length) },
      async () => {
        while (nextIndex < orderedRefs.length) {
          const ref = orderedRefs[nextIndex++];
          const tenantId = this.options.tenantId ?? ref.tenant_id;
          if (!tenantId) continue;
          tenants.add(tenantId);
          await runWithTenantContext(tenantId, () =>
            this.withThreadOrder(`${tenantId}:${this.options.lane(ref)}`, () =>
              this.options.process(ref)
            )
          );
        }
      }
    );
    await Promise.all(workers);
    const purge = this.options.purge;
    if (purge) {
      for (const tenantId of tenants) await runWithTenantContext(tenantId, purge);
    }
    return refs.length;
  }

  private async withThreadOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.threadTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadTails.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.threadTails.get(key) === current) this.threadTails.delete(key);
    }
  }
}
