import { randomUUID } from 'node:crypto';
import type { AgorConfig } from '../config/types.js';
import type {
  OpenSourceTelemetryConfig,
  OpenSourceTelemetryEvent,
  OpenSourceTelemetryLogger,
  OpenSourceTelemetryTransport,
  ResolveTelemetryConfigOptions,
  SegmentBatchPayload,
  SegmentTrackPayload,
} from './types.js';

export const AGOR_TELEMETRY_DOCS_URL = 'https://agor.live/faq#open-source-telemetry';
export const DEFAULT_OPEN_SOURCE_TELEMETRY_ENDPOINT = 'https://api.segment.io/v1/batch';
export const DEFAULT_OPEN_SOURCE_TELEMETRY_WRITE_KEY = 'n7D1Wfs5ur2xdjhrzbXl1z1skriFOrI0';

function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

export function isTelemetryEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.AGOR_TELEMETRY) === true && !isTelemetryFullyDisabledByEnv(env);
}

export function isTelemetryFullyDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DO_NOT_TRACK === '1') return true;
  return envFlag(env.AGOR_TELEMETRY) === false;
}

export function generateTelemetryInstanceId(): string {
  return randomUUID();
}

export function pruneDefaultOpenSourceTelemetryDestination(config: AgorConfig): AgorConfig {
  if (!config.telemetry) return config;

  const telemetry = { ...config.telemetry };
  if (
    telemetry.endpoint === DEFAULT_OPEN_SOURCE_TELEMETRY_ENDPOINT ||
    telemetry.endpoint === null
  ) {
    delete telemetry.endpoint;
  }
  if (
    telemetry.write_key === DEFAULT_OPEN_SOURCE_TELEMETRY_WRITE_KEY ||
    telemetry.write_key === null
  ) {
    delete telemetry.write_key;
  }

  config.telemetry = telemetry;
  return config;
}

export function resolveOpenSourceTelemetryConfig(
  options: ResolveTelemetryConfigOptions = {}
): OpenSourceTelemetryConfig {
  const env = options.env ?? process.env;
  const telemetry = options.config?.telemetry;
  const forced = envFlag(env.AGOR_TELEMETRY);
  const disabledByEnv = isTelemetryFullyDisabledByEnv(env);

  const enabled = disabledByEnv ? false : (forced ?? telemetry?.enabled === true);

  return {
    enabled,
    instanceId: telemetry?.instance_id ?? null,
    endpoint:
      env.AGOR_TELEMETRY_ENDPOINT ?? telemetry?.endpoint ?? DEFAULT_OPEN_SOURCE_TELEMETRY_ENDPOINT,
    writeKey:
      env.AGOR_TELEMETRY_WRITE_KEY ??
      telemetry?.write_key ??
      DEFAULT_OPEN_SOURCE_TELEMETRY_WRITE_KEY,
    debug: envFlag(env.AGOR_TELEMETRY_DEBUG) ?? telemetry?.debug === true,
    timeoutMs: telemetry?.timeout_ms ?? 3000,
    flushIntervalMs: telemetry?.flush_interval_ms ?? 1000,
    maxBatchSize: telemetry?.max_batch_size ?? 10,
  };
}

function warnTelemetry(message: string, error?: unknown): void {
  if (error === undefined) {
    console.warn(`[telemetry] ${message}`);
    return;
  }
  console.warn(`[telemetry] ${message}:`, error instanceof Error ? error.message : String(error));
}

export class SegmentHttpTelemetryTransport implements OpenSourceTelemetryTransport {
  constructor(
    private readonly endpoint: string,
    private readonly writeKey: string | null,
    private readonly timeoutMs: number
  ) {}

  async send(payload: SegmentBatchPayload): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.writeKey) {
      headers.authorization = `Basic ${Buffer.from(`${this.writeKey}:`).toString('base64')}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        warnTelemetry(`delivery returned HTTP ${response.status}`);
      }
    } catch (error) {
      warnTelemetry('delivery failed', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class NoopOpenSourceTelemetryLogger implements OpenSourceTelemetryLogger {
  isEnabled(): boolean {
    return false;
  }
  track(_event: OpenSourceTelemetryEvent): void {}
  async flush(): Promise<void> {}
}

export class BatchedOpenSourceTelemetryLogger implements OpenSourceTelemetryLogger {
  private batch: SegmentTrackPayload[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly config: OpenSourceTelemetryConfig,
    private readonly transport: OpenSourceTelemetryTransport
  ) {}

  isEnabled(): boolean {
    return this.config.enabled === true && !!this.config.instanceId;
  }

  track(input: OpenSourceTelemetryEvent): void {
    if (!this.isEnabled() || !this.config.instanceId) return;
    try {
      const payload: SegmentTrackPayload = {
        type: 'track',
        event: input.event,
        anonymousId: this.config.instanceId,
        properties: sanitizeTelemetryProperties(input.properties),
        timestamp: input.timestamp ?? new Date().toISOString(),
        context: { app: 'agor', telemetry: 'open-source' },
      };
      this.batch.push(payload);
      if (this.batch.length >= this.config.maxBatchSize) {
        void this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch (error) {
      warnTelemetry(`failed to enqueue event "${input.event}"`, error);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.clearTimer();
    const events = this.batch;
    this.batch = [];
    if (events.length === 0) return;

    this.flushing = (async () => {
      await this.transport.send({ sentAt: new Date().toISOString(), batch: events });
      this.flushing = undefined;
      if (this.batch.length > 0) await this.flush();
    })();

    return this.flushing;
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

const FORBIDDEN_PROPERTY_PATTERNS = [
  /(^|_)user_id$/i,
  /(^|_)email$/i,
  /(^|_)(prompt|prompts|prompt_text|prompt_body|prompt_message)$/i,
  /(^|_)(message|messages|message_text|message_body)$/i,
  /repo(_|-)name/i,
  /repo(_|-)url/i,
  /branch_id/i,
  /session_id/i,
  /task_id/i,
  /path/i,
  /secret/i,
  /token/i,
  /key$/i,
];

export function sanitizeTelemetryProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (FORBIDDEN_PROPERTY_PATTERNS.some((pattern) => pattern.test(key))) continue;
    if (value === undefined) continue;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      clean[key] = value;
    } else if (Array.isArray(value)) {
      clean[key] = value.filter((item) => ['string', 'number', 'boolean'].includes(typeof item));
    } else if (typeof value === 'object') {
      clean[key] = sanitizeTelemetryProperties(value as Record<string, unknown>);
    }
  }
  return clean;
}

export function createOpenSourceTelemetryLogger(
  configInput: AgorConfig | { telemetry?: AgorConfig['telemetry'] },
  transport?: OpenSourceTelemetryTransport
): OpenSourceTelemetryLogger {
  const config = resolveOpenSourceTelemetryConfig({ config: configInput });
  if (!config.enabled || !config.instanceId || !config.endpoint) {
    return new NoopOpenSourceTelemetryLogger();
  }
  if (config.endpoint.includes('segment.io') && !config.writeKey) {
    return new NoopOpenSourceTelemetryLogger();
  }
  const resolvedTransport =
    transport ??
    new SegmentHttpTelemetryTransport(config.endpoint, config.writeKey, config.timeoutMs);
  return new BatchedOpenSourceTelemetryLogger(config, resolvedTransport);
}

let globalOpenSourceTelemetryLogger: OpenSourceTelemetryLogger =
  new NoopOpenSourceTelemetryLogger();

export function configureOpenSourceTelemetryLogger(
  config: AgorConfig,
  transport?: OpenSourceTelemetryTransport
): OpenSourceTelemetryLogger {
  globalOpenSourceTelemetryLogger = createOpenSourceTelemetryLogger(config, transport);
  return globalOpenSourceTelemetryLogger;
}

export function setOpenSourceTelemetryLoggerForTests(logger: OpenSourceTelemetryLogger): void {
  globalOpenSourceTelemetryLogger = logger;
}

export function resetOpenSourceTelemetryLoggerForTests(): void {
  globalOpenSourceTelemetryLogger = new NoopOpenSourceTelemetryLogger();
}

export const openSourceTelemetryLogger: OpenSourceTelemetryLogger = {
  isEnabled: () => globalOpenSourceTelemetryLogger.isEnabled(),
  track: (event) => globalOpenSourceTelemetryLogger.track(event),
  flush: () => globalOpenSourceTelemetryLogger.flush(),
};
