import type { AgorDeploymentMode, AgorStatsDSettings } from '@agor/core/config';
import type { DistributedWorkIdentity } from '@agor/core/coordination';
import StatsD, { type ClientOptions } from 'hot-shots';
import { NOOP_METRICS } from './noop.js';
import {
  type MetricsErrorReporter,
  StatsDDaemonMetrics,
  type StatsDTransportClient,
} from './statsd.js';
import type { DaemonMetrics } from './types.js';

export type StatsDClientFactory = (options: ClientOptions) => StatsDTransportClient;

export interface DaemonMetricsFactoryContext {
  workIdentity: DistributedWorkIdentity;
  deploymentMode: AgorDeploymentMode;
}

/**
 * A DogStatsD gauge needs a stable series per daemon. Standalone has one
 * logical instance; HA must opt into an explicit stable replica identity.
 */
export function resolveMetricsWorkIdentity(
  deploymentMode: AgorDeploymentMode,
  workIdentity: DistributedWorkIdentity,
  explicitInstanceId: string | undefined
): DistributedWorkIdentity | undefined {
  if (deploymentMode === 'standalone') {
    return { ...workIdentity, instanceId: 'standalone' };
  }
  const instanceId = explicitInstanceId?.trim();
  return instanceId && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(instanceId)
    ? { ...workIdentity, instanceId }
    : undefined;
}

export function buildStatsDClientOptions(
  config: AgorStatsDSettings,
  context: DaemonMetricsFactoryContext,
  reportError: MetricsErrorReporter
): ClientOptions {
  return {
    protocol: 'udp',
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 8125,
    prefix: config.prefix ?? 'agor.daemon.',
    globalTags: {
      ...(config.global_tags ?? {}),
      daemon_instance: context.workIdentity.instanceId,
      deployment_mode: context.deploymentMode,
    },
    datadog: true,
    cardinality: 'low',
    originDetection: true,
    includeDataDogTags: false,
    includeDatadogTelemetry: false,
    errorHandler: reportError,
  };
}

function createRateLimitedErrorReporter(): MetricsErrorReporter {
  let lastWarningAt = 0;
  return (error) => {
    const now = Date.now();
    if (now - lastWarningAt < 60_000) return;
    lastWarningAt = now;
    console.warn(`[metrics.statsd] exporter error (metrics dropped): ${error.message}`);
  };
}

export function createDaemonMetrics(
  config: AgorStatsDSettings | undefined,
  context: DaemonMetricsFactoryContext,
  factory: StatsDClientFactory = (options) => new StatsD(options)
): DaemonMetrics {
  if (config?.enabled !== true) return NOOP_METRICS;
  const reportError = createRateLimitedErrorReporter();
  try {
    const client = factory(buildStatsDClientOptions(config, context, reportError));
    return new StatsDDaemonMetrics(client, reportError);
  } catch (error) {
    reportError(error instanceof Error ? error : new Error(String(error)));
    return NOOP_METRICS;
  }
}

/** Resolve application-owned metrics without introducing a process singleton. */
export function getDaemonMetrics(owner: object | null | undefined): DaemonMetrics {
  try {
    const metrics = (owner as { get?: (name: 'metrics') => unknown } | null | undefined)?.get?.(
      'metrics'
    );
    if (
      metrics &&
      typeof metrics === 'object' &&
      typeof (metrics as Partial<DaemonMetrics>).increment === 'function'
    ) {
      return metrics as DaemonMetrics;
    }
  } catch {
    // Test doubles and partially constructed apps may reject unknown settings.
  }
  return NOOP_METRICS;
}

export { NOOP_METRICS } from './noop.js';
export { StatsDDaemonMetrics, sanitizeMetricTags } from './statsd.js';
export type { DaemonMetrics, MetricTags, MetricTimer } from './types.js';
