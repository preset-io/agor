import { pathToFileURL } from 'node:url';
import type { AnalyticsPlugin } from 'analytics';
import type {
  AgorAnalyticsHttpBatchPluginSettings,
  AgorAnalyticsModulePluginSettings,
  AgorAnalyticsPluginSettings,
  AgorAnalyticsSettings,
  AgorAnalyticsStdoutPluginSettings,
} from '../config/types.js';
import type { AnalyticsPluginContext, ResolvedAnalyticsPlugin } from './types.js';

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

export function toSegmentLikeTrack(payloadInput: unknown): Record<string, unknown> {
  const payload = toTrackPayload(payloadInput);
  const timestamp = payload.meta?.ts
    ? new Date(payload.meta.ts).toISOString()
    : new Date().toISOString();
  const userId = payload.options?.userId ?? payload.userId ?? undefined;
  const anonymousId = payload.options?.anonymousId ?? payload.anonymousId ?? undefined;

  const event: Record<string, unknown> = {
    type: 'track',
    event: payload.event,
    properties: payload.properties ?? {},
    context: payload.options?.context ?? {},
    timestamp,
  };

  if (userId) event.userId = userId;
  if (anonymousId) event.anonymousId = anonymousId;
  return event;
}

export function createStdoutAnalyticsPlugin(
  settings: AgorAnalyticsStdoutPluginSettings
): ResolvedAnalyticsPlugin {
  const pretty = settings.options?.pretty === true;
  return {
    name: 'agor-stdout-analytics',
    loaded: () => true,
    track: (input: unknown) => {
      try {
        const event = toSegmentLikeTrack(input);
        console.log(pretty ? JSON.stringify(event, null, 2) : JSON.stringify(event));
      } catch (error) {
        warnAnalytics('stdout plugin failed', error);
      }
    },
  };
}

export function createHttpBatchAnalyticsPlugin(
  settings: AgorAnalyticsHttpBatchPluginSettings
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
  const headers = options.headers ?? {};
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
        });
        if (!response.ok) {
          warnAnalytics(`http_batch delivery returned HTTP ${response.status}`);
        }
      } catch (error) {
        warnAnalytics('http_batch delivery failed', error);
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
        batch.push(toSegmentLikeTrack(input));
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

function importTargetForModulePath(modulePath: string): string | null {
  if (modulePath.startsWith('.')) {
    warnAnalytics(
      'module plugin options.module_path must be a package specifier or absolute path; skipping relative path'
    );
    return null;
  }
  if (modulePath.startsWith('/')) {
    return pathToFileURL(modulePath).href;
  }
  return modulePath;
}

export async function createModuleAnalyticsPlugins(
  settings: AgorAnalyticsModulePluginSettings,
  context: AnalyticsPluginContext
): Promise<ResolvedAnalyticsPlugin[]> {
  const options = settings.options ?? {};
  if (!options.module_path) {
    warnAnalytics('module plugin enabled without options.module_path; skipping plugin');
    return [];
  }

  try {
    const importTarget = importTargetForModulePath(options.module_path);
    if (!importTarget) return [];

    const imported = await import(importTarget);
    const exportName = options.export_name ?? 'createAnalyticsPlugin';
    const factory = imported[exportName];
    if (typeof factory !== 'function') {
      warnAnalytics(`module plugin export "${exportName}" is not a function; skipping plugin`);
      return [];
    }
    const result = await factory(options.plugin_options ?? {}, context);
    const plugins = Array.isArray(result) ? result : [result];
    return plugins.filter((plugin): plugin is ResolvedAnalyticsPlugin => {
      return (
        !!plugin &&
        typeof plugin === 'object' &&
        typeof (plugin as AnalyticsPlugin).name === 'string'
      );
    });
  } catch (error) {
    warnAnalytics('module plugin failed to load', error);
    return [];
  }
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
  const resolved: ResolvedAnalyticsPlugin[] = [];
  for (const pluginConfig of config.plugins ?? []) {
    if (pluginConfig.enabled !== true) continue;

    const context: AnalyticsPluginContext = { config, pluginConfig };
    if (pluginConfig.type === 'stdout') {
      resolved.push(createStdoutAnalyticsPlugin(pluginConfig));
    } else if (pluginConfig.type === 'http_batch') {
      const plugin = createHttpBatchAnalyticsPlugin(pluginConfig);
      if (plugin) resolved.push(plugin);
    } else if (pluginConfig.type === 'module') {
      resolved.push(...(await createModuleAnalyticsPlugins(pluginConfig, context)));
    } else {
      const unknown = pluginConfig as AgorAnalyticsPluginSettings;
      warnAnalytics(
        `unknown plugin type "${(unknown as { type?: string }).type}"; skipping plugin`
      );
    }
  }

  return resolved.map(wrapAnalyticsPlugin);
}
