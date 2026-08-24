import { createRequire } from 'node:module';
import type { AgorDeploymentMode, AgorStatsDSettings } from '@agor/core/config';
import type { DistributedWorkIdentity } from '@agor/core/coordination';
import { NOOP_METRICS } from './noop.js';
import {
  type MetricsErrorReporter,
  StatsDDaemonMetrics,
  type StatsDTransportClient,
} from './statsd.js';
import type { DaemonMetrics } from './types.js';

interface StatsDClientOptions {
  protocol: 'udp';
  host: string;
  port: number;
  prefix: string;
  globalTags: Record<string, string>;
  datadog: true;
  cardinality: 'low';
  originDetection: true;
  includeDataDogTags: false;
  includeDatadogTelemetry: false;
  errorHandler: MetricsErrorReporter;
}

type StatsDClientConstructor = new (options: StatsDClientOptions) => StatsDTransportClient;

const requireFromDaemon = createRequire(import.meta.url);

export type StatsDClientFactory = (options: StatsDClientOptions) => StatsDTransportClient;

function createHotShotsClient(options: StatsDClientOptions): StatsDTransportClient {
  let StatsD: StatsDClientConstructor;
  try {
    StatsD = requireFromDaemon('hot-shots') as StatsDClientConstructor;
  } catch (error) {
    throw new Error(
      'DogStatsD metrics require the optional hot-shots peer dependency. Install hot-shots alongside agor-live, or disable metrics.statsd.',
      { cause: error }
    );
  }
  return new StatsD(options);
}

export interface DaemonMetricsFactoryContext {
  workIdentity: DistributedWorkIdentity;
  deploymentMode: AgorDeploymentMode;
  deploymentId: string;
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
): StatsDClientOptions {
  return {
    protocol: 'udp',
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 8125,
    prefix: config.prefix ?? 'agor.daemon.',
    globalTags: {
      ...(config.global_tags ?? {}),
      deployment_id: context.deploymentId,
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
  factory: StatsDClientFactory = createHotShotsClient
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

function isDaemonMetrics(candidate: unknown): candidate is DaemonMetrics {
  if (!candidate || typeof candidate !== 'object') return false;
  const metrics = candidate as Partial<DaemonMetrics>;
  return (
    typeof metrics.enabled === 'boolean' &&
    typeof metrics.increment === 'function' &&
    typeof metrics.decrement === 'function' &&
    typeof metrics.gauge === 'function' &&
    typeof metrics.histogram === 'function' &&
    typeof metrics.timing === 'function' &&
    typeof metrics.distribution === 'function' &&
    typeof metrics.startTimer === 'function' &&
    typeof metrics.flush === 'function' &&
    typeof metrics.close === 'function'
  );
}

/** Resolve application-owned metrics without introducing a process singleton. */
export function getDaemonMetrics(owner: object | null | undefined): DaemonMetrics {
  try {
    const metrics = (owner as { get?: (name: 'metrics') => unknown } | null | undefined)?.get?.(
      'metrics'
    );
    if (isDaemonMetrics(metrics)) return metrics;
  } catch {
    // Test doubles and partially constructed apps may reject unknown settings.
  }
  return NOOP_METRICS;
}

export { NOOP_METRICS } from './noop.js';
export { StatsDDaemonMetrics, sanitizeMetricTags } from './statsd.js';
export type { DaemonMetrics, MetricTags, MetricTimer } from './types.js';
