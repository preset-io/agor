import type { AnalyticsInstance } from 'analytics';
import { Analytics } from 'analytics';
import { getDefaultAnalyticsConfig } from '../config/analytics-defaults.js';
import type { AgorAnalyticsSettings, AgorConfig } from '../config/types.js';
import { isAnalyticsEventExcluded } from './filters.js';
import { resolveAnalyticsPlugins } from './plugins.js';
import type { AnalyticsLogger, AnalyticsProperties, AnalyticsTrackOptions } from './types.js';

function mergeAnalyticsConfig(config?: AgorAnalyticsSettings): AgorAnalyticsSettings {
  const defaults = getDefaultAnalyticsConfig();
  if (!config) return defaults;

  return {
    ...defaults,
    ...config,
    client: {
      ...defaults.client,
      ...config.client,
    },
    filters: {
      ...defaults.filters,
      ...config.filters,
    },
    plugins: config.plugins ?? defaults.plugins,
  };
}

export function resolveAnalyticsConfig(
  config: AgorConfig | AgorAnalyticsSettings
): AgorAnalyticsSettings {
  if ('analytics' in config) {
    return mergeAnalyticsConfig(config.analytics);
  }
  return mergeAnalyticsConfig(config as AgorAnalyticsSettings);
}

export class NoopAnalyticsLogger implements AnalyticsLogger {
  isEnabled(): boolean {
    return false;
  }

  track(_event: string, _properties?: AnalyticsProperties, _options?: AnalyticsTrackOptions): void {
    // Intentionally empty: analytics is off by default and must be safe to call unconditionally.
  }
}

export class AnalyticsPackageLogger implements AnalyticsLogger {
  private readonly client: AnalyticsInstance;
  private readonly excludeEvents: readonly string[];

  constructor(client: AnalyticsInstance, excludeEvents: readonly string[] = []) {
    this.client = client;
    this.excludeEvents = excludeEvents;
  }

  isEnabled(): boolean {
    return true;
  }

  track(
    event: string,
    properties: AnalyticsProperties = {},
    options: AnalyticsTrackOptions = {}
  ): void {
    if (isAnalyticsEventExcluded(event, this.excludeEvents)) return;

    const trackOptions: Record<string, unknown> = {};
    if (options.context) trackOptions.context = options.context;
    if (options.userId) trackOptions.userId = options.userId;
    if (options.anonymousId) trackOptions.anonymousId = options.anonymousId;

    try {
      void this.client.track(event, properties, trackOptions).catch((error: unknown) => {
        console.warn(
          `[analytics] track failed for "${event}":`,
          error instanceof Error ? error.message : String(error)
        );
      });
    } catch (error) {
      console.warn(
        `[analytics] track failed for "${event}":`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

export async function createAnalyticsLogger(
  config: AgorConfig | AgorAnalyticsSettings
): Promise<AnalyticsLogger> {
  const resolved = resolveAnalyticsConfig(config);
  if (resolved.enabled !== true) return new NoopAnalyticsLogger();

  const plugins = await resolveAnalyticsPlugins(resolved);
  const client = Analytics({
    ...(resolved.client ?? {}),
    plugins,
  });

  return new AnalyticsPackageLogger(client, resolved.filters?.exclude_events ?? []);
}

let globalAnalyticsLogger: AnalyticsLogger = new NoopAnalyticsLogger();

export async function configureAnalyticsLogger(
  config: AgorConfig | AgorAnalyticsSettings
): Promise<AnalyticsLogger> {
  try {
    globalAnalyticsLogger = await createAnalyticsLogger(config);
  } catch (error) {
    console.warn(
      '[analytics] failed to configure analytics; continuing with analytics disabled:',
      error instanceof Error ? error.message : String(error)
    );
    globalAnalyticsLogger = new NoopAnalyticsLogger();
  }
  return globalAnalyticsLogger;
}

export function setAnalyticsLoggerForTests(logger: AnalyticsLogger): void {
  globalAnalyticsLogger = logger;
}

export function resetAnalyticsLoggerForTests(): void {
  globalAnalyticsLogger = new NoopAnalyticsLogger();
}

export const analyticsLogger: AnalyticsLogger = {
  isEnabled: () => globalAnalyticsLogger.isEnabled(),
  track: (event, properties, options) => globalAnalyticsLogger.track(event, properties, options),
};
