import type { DaemonMetrics } from './types.js';

export type OwnStartupMetrics = (metrics: DaemonMetrics) => void;

function reportCloseFailure(error: unknown): void {
  try {
    console.warn('[metrics.statsd] Failed to close exporter after daemon startup failure:', error);
  } catch {
    // Cleanup reporting must not replace the startup failure.
  }
}

/**
 * Own a metrics exporter until daemon startup completes and transfers its
 * lifecycle to the registered signal handler. A failed startup cannot leave
 * hot-shots' UDP socket alive in programmatic callers or tests.
 */
export async function runWithStartupMetricsOwner(
  operation: (ownMetrics: OwnStartupMetrics) => Promise<void>,
  onCloseFailure: (error: unknown) => void = reportCloseFailure
): Promise<void> {
  let ownedMetrics: DaemonMetrics | undefined;
  try {
    await operation((metrics) => {
      if (ownedMetrics && ownedMetrics !== metrics) {
        throw new Error('Daemon startup attempted to initialize metrics more than once');
      }
      ownedMetrics = metrics;
    });
  } catch (startupError) {
    if (ownedMetrics) {
      try {
        await ownedMetrics.close();
      } catch (closeError) {
        try {
          onCloseFailure(closeError);
        } catch {
          // Preserve the original daemon startup error.
        }
      }
    }
    throw startupError;
  }
}
