import {
  isSafeAnalyticsKey,
  isValidAnalyticsHeaderValue,
  validateAnalyticsHeaders,
  validateAnalyticsMetadata,
} from '../config/analytics-validation.js';
import type {
  AgorAnalyticsHttpBatchPluginSettings,
  AgorAnalyticsSettings,
  AgorAnalyticsStdoutPluginSettings,
} from '../config/types.js';
import { segmentTrackFields } from './segment.js';
import { OPERATOR_OWNED_ANALYTICS_CONTEXT_KEYS, type ResolvedAnalyticsPlugin } from './types.js';

interface AnalyticsTrackPayload {
  type?: string;
  event?: string;
  properties?: Record<string, unknown>;
  options?: {
    userId?: string | null;
    anonymousId?: string | null;
    context?: Record<string, unknown>;
  };
  userId?: string | null;
  anonymousId?: string | null;
  meta?: {
    ts?: number;
  };
}

function warnAnalytics(message: string, error?: unknown): void {
  if (error === undefined) {
    console.warn(`[analytics] ${message}`);
    return;
  }
  console.warn(`[analytics] ${message}:`, error instanceof Error ? error.message : String(error));
}

function toTrackPayload(input: unknown): AnalyticsTrackPayload {
  if (!input || typeof input !== 'object') return {};
  const wrapper = input as { payload?: unknown };
  const payload = wrapper.payload && typeof wrapper.payload === 'object' ? wrapper.payload : input;
  return payload as AnalyticsTrackPayload;
}

export function toSegmentLikeTrack(
  payloadInput: unknown,
  metadata?: Pick<AgorAnalyticsSettings, 'client' | 'extras'>
): Record<string, unknown> {
  const payload = toTrackPayload(payloadInput);
  const timestamp = payload.meta?.ts
    ? new Date(payload.meta.ts).toISOString()
    : new Date().toISOString();
  const userId = payload.options?.userId ?? payload.userId ?? undefined;
  const anonymousId = payload.options?.anonymousId ?? payload.anonymousId ?? undefined;

  const event: Record<string, unknown> = {
    type: 'track',
    ...segmentTrackFields(payload.event, payload.properties),
    context: {
      ...Object.fromEntries(
        Object.entries(payload.options?.context ?? {}).filter(
          ([key]) =>
            isSafeAnalyticsKey(key) &&
            (!metadata || !OPERATOR_OWNED_ANALYTICS_CONTEXT_KEYS.includes(key))
        )
      ),
      ...(metadata
        ? {
            app: {
              name: metadata.client?.app,
              ...(metadata.client?.version !== undefined
                ? { version: String(metadata.client.version) }
                : {}),
            },
            extras: { ...metadata.extras },
          }
        : {}),
    },
    timestamp,
  };

  if (userId) event.userId = userId;
  if (anonymousId) event.anonymousId = anonymousId;
  return event;
}

export function createStdoutAnalyticsPlugin(
  settings: AgorAnalyticsStdoutPluginSettings,
  metadata?: Pick<AgorAnalyticsSettings, 'client' | 'extras'>
): ResolvedAnalyticsPlugin {
  const pretty = settings.options?.pretty === true;
  return {
    name: 'agor-stdout-analytics',
    loaded: () => true,
    track: (input: unknown) => {
      try {
        const event = toSegmentLikeTrack(input, metadata);
        console.log(pretty ? JSON.stringify(event, null, 2) : JSON.stringify(event));
      } catch (error) {
        warnAnalytics('stdout plugin failed', error);
      }
    },
  };
}

export function createHttpBatchAnalyticsPlugin(
  settings: AgorAnalyticsHttpBatchPluginSettings,
  metadata?: Pick<AgorAnalyticsSettings, 'client' | 'extras'>
): ResolvedAnalyticsPlugin | null {
  const options = settings.options ?? {};
  const url = options.url;
  if (!url) {
    warnAnalytics('http_batch plugin enabled without options.url; skipping plugin');
    return null;
  }

  const flushIntervalMs = Math.max(1, options.flush_interval_ms ?? 1000);
  const maxBatchSize = Math.max(1, options.max_batch_size ?? 50);
  const timeoutMs = Math.max(1, options.timeout_ms ?? 3000);
  validateAnalyticsHeaders(options);
  // Credentials exist only in this transport closure, never plugin config / SDK state.
  const headers: Record<string, string> = { ...options.headers };
  for (const [name, envName] of Object.entries(options.headers_from_env ?? {})) {
    const value = process.env[envName];
    if (!isValidAnalyticsHeaderValue(value, true)) {
      throw new Error(
        'Analytics http_batch header environment value is missing, empty, or invalid'
      );
    }
    headers[name] = value;
  }
  let batch: Record<string, unknown>[] = [];
  let timer: NodeJS.Timeout | undefined;
  let flushing: Promise<void> | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const flush = async () => {
    if (flushing) return flushing;
    clearTimer();
    const events = batch;
    batch = [];
    if (events.length === 0) return;

    flushing = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...headers,
          },
          body: JSON.stringify({
            sentAt: new Date().toISOString(),
            batch: events,
          }),
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          warnAnalytics(`http_batch delivery returned HTTP ${response.status}`);
        }
      } catch {
        // Fetch errors can include request headers or URLs. Never log their details.
        warnAnalytics('http_batch delivery failed');
      } finally {
        clearTimeout(timeout);
        flushing = undefined;
        if (batch.length > 0) {
          void flush();
        }
      }
    })();

    return flushing;
  };

  const scheduleFlush = () => {
    if (timer) return;
    timer = setTimeout(() => {
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  };

  return {
    name: 'agor-http-batch-analytics',
    loaded: () => true,
    track: (input: unknown) => {
      try {
        batch.push(toSegmentLikeTrack(input, metadata));
        if (batch.length >= maxBatchSize) {
          void flush();
        } else {
          scheduleFlush();
        }
      } catch (error) {
        warnAnalytics('http_batch plugin failed', error);
      }
    },
    flush,
  };
}

function wrapPluginMethod(pluginName: string, methodName: string, method: unknown): unknown {
  if (typeof method !== 'function') return method;
  return (...args: unknown[]) => {
    try {
      const result = method(...args);
      if (result && typeof result === 'object' && 'catch' in result) {
        return (result as Promise<unknown>).catch((error) => {
          warnAnalytics(`${pluginName}.${methodName} failed`, error);
        });
      }
      return result;
    } catch (error) {
      warnAnalytics(`${pluginName}.${methodName} failed`, error);
      return undefined;
    }
  };
}

export function wrapAnalyticsPlugin(plugin: ResolvedAnalyticsPlugin): ResolvedAnalyticsPlugin {
  const wrapped: ResolvedAnalyticsPlugin = { ...plugin };
  for (const methodName of ['initialize', 'page', 'track', 'identify', 'ready'] as const) {
    wrapped[methodName] = wrapPluginMethod(plugin.name, methodName, plugin[methodName]) as never;
  }
  wrapped.loaded = typeof plugin.loaded === 'function' ? plugin.loaded : () => true;
  return wrapped;
}

export async function resolveAnalyticsPlugins(
  config: AgorAnalyticsSettings
): Promise<ResolvedAnalyticsPlugin[]> {
  validateAnalyticsMetadata(config);
  // Snapshot operator metadata so later caller mutation cannot change event identity.
  const metadata = { client: { ...config.client }, extras: { ...config.extras } };
  const resolved: ResolvedAnalyticsPlugin[] = [];
  for (const pluginConfig of config.plugins ?? []) {
    if (pluginConfig.enabled !== true) continue;

    switch (pluginConfig.type) {
      case 'stdout':
        resolved.push(createStdoutAnalyticsPlugin(pluginConfig, metadata));
        break;
      case 'http_batch': {
        const plugin = createHttpBatchAnalyticsPlugin(pluginConfig, metadata);
        if (plugin) resolved.push(plugin);
        break;
      }
      default: {
        const unsupported: never = pluginConfig;
        const type = (unsupported as { type?: unknown }).type;
        throw new Error(`Unsupported analytics plugin type: ${String(type)}`);
      }
    }
  }

  return resolved.map(wrapAnalyticsPlugin);
}
