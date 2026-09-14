import type { ResolvedRedisSettings } from '@agor/core/config';
import {
  isRealtimeRelayEnvelope,
  REALTIME_RELAY_EVENT,
  type RealtimeRelayEnvelope,
} from '@agor/core/realtime';
import type { RedisRealtimeHealth } from '@agor/core/types';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { type RedisOptions } from 'ioredis';
import type { Namespace, Server } from 'socket.io';

export function redisAdapterKey(keyPrefix: string): string {
  return `${keyPrefix}:socket.io`;
}

type RelayHandler = (envelope: RealtimeRelayEnvelope) => void | Promise<void>;

export interface RedisRealtimeLifecycle {
  /**
   * Synchronous local fence invoked once for each ready -> unavailable
   * transition. The daemon uses it to clear authorization caches and retire
   * process-local terminal capabilities before transports reconnect.
   */
  onUnavailable?: () => void;
}

function safeRedisError(label: string, error: unknown): void {
  // ioredis errors may contain a credential-bearing URL. Only expose the
  // stable error code/name; the configured URL never crosses this boundary.
  const value = error as { code?: unknown; name?: unknown } | undefined;
  const kind =
    typeof value?.code === 'string'
      ? value.code
      : typeof value?.name === 'string'
        ? value.name
        : 'RedisError';
  console.warn(`[realtime/redis] ${label}: ${kind}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function redisRealtimeClientOptions(
  settings: ResolvedRedisSettings,
  role: 'publisher' | 'subscriber'
): RedisOptions {
  const retryStrategy = (times: number) => {
    const exponential = Math.min(
      settings.reconnectMaxDelayMs,
      settings.reconnectBaseDelayMs * 2 ** Math.min(times - 1, 10)
    );
    // Jitter prevents all replicas reconnecting on the same boundary.
    return Math.max(1, Math.floor(exponential * (0.75 + Math.random() * 0.5)));
  };
  const common: RedisOptions = {
    lazyConnect: true,
    connectTimeout: settings.connectTimeoutMs,
    enableReadyCheck: true,
    retryStrategy,
  };
  if (role === 'publisher') {
    return {
      ...common,
      // Socket.IO ignores the Promise returned by publish(). Never retain a
      // packet across an outage: fail it promptly instead of replaying stale
      // cursor/presence/native traffic after Redis recovers.
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 1,
      autoResubscribe: false,
    };
  }
  return {
    ...common,
    // Subscriber state is safe to reconstruct; retain ioredis resubscription
    // behavior independently from the publisher's fail-fast command policy.
    autoResubscribe: true,
    maxRetriesPerRequest: null,
  };
}

/** Owns the two Redis clients and the Socket.IO adapter for one daemon boot. */
export class RedisRealtimeRuntime {
  private readonly pubClient: Redis;
  private readonly subClient: Redis;
  private io: Server | null = null;
  private namespace: Namespace | null = null;
  private relayHandler: RelayHandler | null = null;
  private adapterAttached = false;
  private draining = false;
  private unavailableFenced = false;

  constructor(
    private readonly settings: ResolvedRedisSettings,
    private readonly diagnostics: { instanceId: string; bootId: string },
    private readonly lifecycle: RedisRealtimeLifecycle = {}
  ) {
    this.pubClient = new Redis(settings.url, redisRealtimeClientOptions(settings, 'publisher'));
    this.subClient = new Redis(settings.url, redisRealtimeClientOptions(settings, 'subscriber'));
    // @socket.io/redis-adapter intentionally does not await ordinary publish
    // calls. Attach a rejection observer so fail-fast outage errors cannot
    // surface as unhandled rejections; callers that do await still receive the
    // original rejected Promise.
    const publish = this.pubClient.publish.bind(this.pubClient);
    this.pubClient.publish = ((...args: unknown[]) => {
      const command = (publish as (...values: unknown[]) => Promise<number>)(...args);
      void command.catch(() => undefined);
      return command;
    }) as Redis['publish'];
    this.pubClient.on('error', (error) => safeRedisError('publisher connection error', error));
    this.subClient.on('error', (error) => safeRedisError('subscriber connection error', error));
    for (const client of [this.pubClient, this.subClient]) {
      client.on('ready', () => this.handleAvailabilityChange());
      client.on('close', () => this.handleAvailabilityChange());
      client.on('end', () => this.handleAvailabilityChange());
      client.on('reconnecting', () => this.handleAvailabilityChange());
    }
  }

  async connect(): Promise<void> {
    try {
      await withTimeout(
        Promise.all([this.pubClient.connect(), this.subClient.connect()]).then(() => undefined),
        this.settings.startupTimeoutMs,
        'Redis startup timeout'
      );
      console.log(
        `[realtime/redis] connected namespace=${this.settings.keyPrefix} instance=${this.diagnostics.instanceId} boot=${this.diagnostics.bootId}`
      );
    } catch (error) {
      this.pubClient.disconnect(false);
      this.subClient.disconnect(false);
      safeRedisError('required HA startup connection failed', error);
      throw new Error('HA startup failed: required Redis fanout plane is unavailable');
    }
  }

  /** Socket.IO server option; call only after connect(). */
  get adapter() {
    return createAdapter(this.pubClient, this.subClient, {
      key: redisAdapterKey(this.settings.keyPrefix),
      requestsTimeout: this.settings.requestTimeoutMs,
    });
  }

  attach(io: Server): void {
    this.io = io;
    this.namespace = io.of('/');
    this.adapterAttached = true;
    // A namespace middleware rejection is terminal to Socket.IO's automatic
    // reconnect loop. Reject unhealthy HA admission one layer lower by closing
    // the Engine.IO transport instead; clients keep retrying and will present a
    // fresh authenticated namespace handshake after Redis recovers.
    io.engine.on('connection', (connection) => {
      if (!this.isReady()) connection.close(true);
    });
    // serverSideEmit is namespace-scoped. Use the root Namespace explicitly
    // rather than relying on Server's EventEmitter delegation so send and
    // receive are guaranteed to bind to the same adapter instance.
    this.namespace.on(REALTIME_RELAY_EVENT, (raw: unknown) => {
      if (!this.relayHandler || !isRealtimeRelayEnvelope(raw)) return;
      if (process.env.AGOR_DEBUG_REALTIME_PUBLISH === '1') {
        console.debug(
          `[realtime/redis] relay received path=${raw.path} event=${raw.event} tenant=${raw.tenantId}`
        );
      }
      void Promise.resolve(this.relayHandler(raw)).catch((error) =>
        safeRedisError('relayed Feathers publication rejected', error)
      );
    });
    this.handleAvailabilityChange();
  }

  setRelayHandler(handler: RelayHandler): void {
    this.relayHandler = handler;
  }

  relay(envelope: RealtimeRelayEnvelope): void {
    if (!this.io || !this.namespace || !this.isReady()) {
      throw new Error('Required Redis realtime adapter is not ready');
    }
    // serverSideEmit is delivered to every *other* Socket.IO server. The
    // originating daemon performs its normal Feathers delivery locally.
    if (process.env.AGOR_DEBUG_REALTIME_PUBLISH === '1') {
      console.debug(
        `[realtime/redis] relay sent path=${envelope.path} event=${envelope.event} tenant=${envelope.tenantId}`
      );
    }
    this.namespace.serverSideEmit(REALTIME_RELAY_EVENT, envelope);
  }

  beginDrain(): void {
    this.draining = true;
  }

  /**
   * Fence one Redis outage without turning it into a permanent namespace
   * disconnect. Ordinary database/REST authority remains available; only the
   * distributed realtime plane is retired until both Redis clients are ready.
   */
  private handleAvailabilityChange(): void {
    if (!this.adapterAttached || this.draining) return;
    if (this.isReady()) {
      this.unavailableFenced = false;
      return;
    }
    if (this.unavailableFenced) return;
    this.unavailableFenced = true;
    console.warn(
      `[realtime/redis] required fanout unavailable; fencing socket transports instance=${this.diagnostics.instanceId} boot=${this.diagnostics.bootId}`
    );
    try {
      this.lifecycle.onUnavailable?.();
    } catch (error) {
      // Transport retirement must still happen if one local cache/capability
      // listener fails. The replacement handshake remains the final fence.
      safeRedisError('local outage fence failed', error);
    }
    // Close the transport, not the Socket.IO namespace. `disconnect(true)`
    // disables automatic client reconnection; Engine.IO close preserves it.
    for (const socket of this.io?.sockets.sockets.values() ?? []) {
      socket.conn.close();
    }
  }

  isReady(): boolean {
    return (
      !this.draining &&
      this.adapterAttached &&
      this.pubClient.status === 'ready' &&
      this.subClient.status === 'ready'
    );
  }

  health(): RedisRealtimeHealth {
    return {
      required: true,
      ready: this.isReady(),
      draining: this.draining,
      adapterAttached: this.adapterAttached,
      pubStatus: this.pubClient.status,
      subStatus: this.subClient.status,
    };
  }

  async close(): Promise<void> {
    this.beginDrain();
    this.adapterAttached = false;
    this.unavailableFenced = false;
    this.io = null;
    this.namespace = null;
    const closeClient = async (client: Redis) => {
      if (client.status === 'end') return;
      try {
        await withTimeout(client.quit(), 2_000, 'Redis quit timeout');
      } catch {
        client.disconnect(false);
      }
    };
    await Promise.all([closeClient(this.pubClient), closeClient(this.subClient)]);
  }
}
