import type { ResolvedRedisSettings } from '@agor/core/config';
import {
  BranchRealtimeVisibilityMode,
  type BranchRemovalRealtimeVisibilitySnapshot,
  REALTIME_RELAY_VERSION,
  type RealtimeRelayEnvelope,
  type RedisRealtimeHealth,
} from '@agor/core/types';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis, { type RedisOptions } from 'ioredis';
import type { Namespace, Server } from 'socket.io';

export const FEATHERS_RELAY_EVENT = 'agor:feathers-publication:v1';
export const MAX_REALTIME_RELAY_BYTES = 512 * 1024;

export function redisAdapterKey(keyPrefix: string): string {
  return `${keyPrefix}:socket.io`;
}

type RelayHandler = (envelope: RealtimeRelayEnvelope) => void | Promise<void>;

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

  constructor(
    private readonly settings: ResolvedRedisSettings,
    private readonly diagnostics: { instanceId: string; bootId: string }
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
    // serverSideEmit is namespace-scoped. Use the root Namespace explicitly
    // rather than relying on Server's EventEmitter delegation so send and
    // receive are guaranteed to bind to the same adapter instance.
    this.namespace.on(FEATHERS_RELAY_EVENT, (raw: unknown) => {
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
    this.namespace.serverSideEmit(FEATHERS_RELAY_EVENT, envelope);
  }

  beginDrain(): void {
    this.draining = true;
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

export function isRealtimeRelayEnvelope(value: unknown): value is RealtimeRelayEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  let envelopeIsBoundedJson = false;
  try {
    const encoded = JSON.stringify(v);
    envelopeIsBoundedJson =
      encoded !== undefined && Buffer.byteLength(encoded, 'utf8') <= MAX_REALTIME_RELAY_BYTES;
  } catch {
    envelopeIsBoundedJson = false;
  }
  const removalVisibility = v.branchRemovalVisibility;
  const removalVisibilityValid =
    removalVisibility === undefined ||
    (v.path === 'branches' &&
      v.event === 'removed' &&
      isBranchRemovalRealtimeVisibilitySnapshot(removalVisibility));
  return (
    v.version === REALTIME_RELAY_VERSION &&
    typeof v.tenantId === 'string' &&
    v.tenantId.length > 0 &&
    v.tenantId.length <= 128 &&
    typeof v.path === 'string' &&
    v.path.length > 0 &&
    v.path.length <= 128 &&
    typeof v.event === 'string' &&
    v.event.length > 0 &&
    v.event.length <= 128 &&
    (v.method === undefined || (typeof v.method === 'string' && v.method.length <= 128)) &&
    (v.id === undefined ||
      (typeof v.id === 'string' && v.id.length <= 256) ||
      (typeof v.id === 'number' && Number.isFinite(v.id))) &&
    'data' in v &&
    envelopeIsBoundedJson &&
    removalVisibilityValid
  );
}

export function isBranchRemovalRealtimeVisibilitySnapshot(
  value: unknown
): value is BranchRemovalRealtimeVisibilitySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.branchId !== 'string' ||
    snapshot.branchId.length === 0 ||
    snapshot.branchId.length > 256
  ) {
    return false;
  }
  if (snapshot.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED) {
    return snapshot.userIds === undefined;
  }
  return (
    snapshot.mode === BranchRealtimeVisibilityMode.EXPLICIT_USERS &&
    Array.isArray(snapshot.userIds) &&
    snapshot.userIds.every(
      (userId) => typeof userId === 'string' && userId.length > 0 && userId.length <= 256
    )
  );
}
