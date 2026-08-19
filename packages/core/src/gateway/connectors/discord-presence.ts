import {
  ActivityType,
  GatewayOpcodes,
  type GatewayPresenceUpdateData,
  type GatewaySendPayload,
  PresenceUpdateStatus,
} from 'discord-api-types/v10';
import type { GatewayAggregatePresenceDiagnostic } from '../connector';

export const DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS = 5_000;
export const DISCORD_PRESENCE_ACTIVE_COUNT_CAP = 999;
const DISCORD_PRESENCE_MAX_RETRIES = 3;
const DISCORD_PRESENCE_MAX_SHARDS = 4_096;

export interface DiscordPresenceTransport {
  getShardIds(force?: boolean): Promise<number[]>;
  send(shardId: number, payload: GatewaySendPayload): PromiseLike<void> | void;
}

interface DiscordPresenceControllerOptions {
  beforeSend: () => Promise<boolean>;
  onDiagnostic?: (diagnostic: GatewayAggregatePresenceDiagnostic) => void;
  now?: () => number;
  minSendIntervalMs?: number;
  maxRetries?: number;
}

function clampActiveCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(DISCORD_PRESENCE_ACTIVE_COUNT_CAP, Math.floor(value));
}

/** Build the only launch-approved Discord aggregate presence payload. */
export function buildDiscordAggregatePresence(activeCount: number): GatewayPresenceUpdateData {
  const count = clampActiveCount(activeCount);
  return {
    since: null,
    afk: false,
    status: count === 0 ? PresenceUpdateStatus.Idle : PresenceUpdateStatus.Online,
    activities: [
      {
        name:
          count === 0
            ? 'for @mentions'
            : `${count} active Agor ${count === 1 ? 'session' : 'sessions'}`,
        type: ActivityType.Watching,
      },
    ],
  };
}

/**
 * Process-local, latest-value-wins Discord presence controller.
 *
 * The durable mapping metadata remains the source of truth. This controller
 * only rate-limits broadcasts through the exact listener-owned WebSocket
 * manager and becomes inert as soon as its database ownership fence is lost.
 */
export class DiscordAggregatePresenceController {
  private desiredActiveCount: number | null = null;
  private lastSentActiveCount: number | null = null;
  private desiredRevision = 0;
  private sentRevision = 0;
  private lastAttemptAt: number | null = null;
  private retryCount = 0;
  private lastErrorCode?: GatewayAggregatePresenceDiagnostic['lastErrorCode'];
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly minSendIntervalMs: number;
  private readonly maxRetries: number;
  private lastReported = '';

  constructor(
    private readonly transport: DiscordPresenceTransport,
    private readonly options: DiscordPresenceControllerOptions
  ) {
    this.now = options.now ?? Date.now;
    this.minSendIntervalMs = options.minSendIntervalMs ?? DISCORD_PRESENCE_MIN_SEND_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DISCORD_PRESENCE_MAX_RETRIES;
  }

  request(activeCount: number): void {
    if (this.stopped) return;
    const next = clampActiveCount(activeCount);
    if (this.desiredActiveCount !== next) {
      this.desiredActiveCount = next;
      this.desiredRevision += 1;
      this.retryCount = 0;
      this.lastErrorCode = undefined;
    }
    if (
      this.desiredRevision === this.sentRevision &&
      this.lastSentActiveCount === this.desiredActiveCount
    ) {
      this.report();
      return;
    }
    this.schedule();
  }

  /** A READY/RESUMED shard needs the latest aggregate even when unchanged. */
  resend(): void {
    if (this.stopped || this.desiredActiveCount === null) return;
    this.desiredRevision += 1;
    this.retryCount = 0;
    this.lastErrorCode = undefined;
    this.schedule();
  }

  getDiagnostic(): GatewayAggregatePresenceDiagnostic {
    return {
      desiredActiveCount: this.desiredActiveCount,
      lastSentActiveCount: this.lastSentActiveCount,
      pending:
        !this.stopped &&
        this.desiredActiveCount !== null &&
        this.desiredRevision !== this.sentRevision,
      retryCount: this.retryCount,
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.report();
  }

  private report(): void {
    const diagnostic = this.getDiagnostic();
    const serialized = JSON.stringify(diagnostic);
    if (serialized === this.lastReported) return;
    this.lastReported = serialized;
    this.options.onDiagnostic?.(diagnostic);
  }

  private schedule(): void {
    if (this.stopped || this.inFlight || this.desiredActiveCount === null) return;
    if (this.timer) clearTimeout(this.timer);
    const elapsed =
      this.lastAttemptAt === null ? Number.POSITIVE_INFINITY : this.now() - this.lastAttemptAt;
    const delay = Math.max(0, this.minSendIntervalMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.beginFlush();
    }, delay);
    this.timer.unref?.();
    this.report();
  }

  private beginFlush(): void {
    if (this.stopped || this.inFlight || this.desiredActiveCount === null) return;
    const work = this.flush().finally(() => {
      if (this.inFlight === work) this.inFlight = null;
      if (
        !this.stopped &&
        this.desiredActiveCount !== null &&
        this.desiredRevision !== this.sentRevision &&
        this.retryCount <= this.maxRetries
      ) {
        this.schedule();
      }
      this.report();
    });
    this.inFlight = work;
    void work;
  }

  private async ownerIsCurrent(): Promise<boolean> {
    if (this.stopped) return false;
    const current = await this.options.beforeSend().catch(() => false);
    if (!current || this.stopped) {
      this.lastErrorCode = 'discord_presence_owner_lost';
      this.stop();
      return false;
    }
    return true;
  }

  private async flush(): Promise<void> {
    const activeCount = this.desiredActiveCount;
    const revision = this.desiredRevision;
    if (activeCount === null || !(await this.ownerIsCurrent())) return;

    // Count an attempted broadcast even if shard discovery/send fails. This is
    // deliberately more conservative than Discord's 5 updates / 20 seconds.
    this.lastAttemptAt = this.now();
    try {
      const shardIds = await this.transport.getShardIds();
      if (
        !Array.isArray(shardIds) ||
        shardIds.length < 1 ||
        shardIds.length > DISCORD_PRESENCE_MAX_SHARDS ||
        shardIds.some((id) => !Number.isSafeInteger(id) || id < 0) ||
        new Set(shardIds).size !== shardIds.length
      ) {
        throw new Error('Discord shard inventory is invalid');
      }
      const payload: GatewaySendPayload = {
        op: GatewayOpcodes.PresenceUpdate,
        d: buildDiscordAggregatePresence(activeCount),
      };
      for (const shardId of shardIds) {
        if (!(await this.ownerIsCurrent())) return;
        await this.transport.send(shardId, payload);
      }
      if (this.stopped) return;
      this.lastSentActiveCount = activeCount;
      this.sentRevision = revision;
      this.retryCount = 0;
      this.lastErrorCode = undefined;
    } catch {
      if (this.stopped) return;
      // A later desired value resets this counter and supersedes the retry.
      if (this.desiredRevision === revision) this.retryCount += 1;
      this.lastErrorCode = 'discord_presence_send_failed';
      if (this.retryCount > this.maxRetries) this.sentRevision = this.desiredRevision;
    }
  }
}
