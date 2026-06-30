import type { AgorConfig } from '@agor/core/config';

export function getOpenSourceTelemetryUtcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function shouldEmitOpenSourceTelemetryDaemonActive(
  config: AgorConfig,
  now = new Date()
): { day: string; shouldEmit: boolean } {
  const day = getOpenSourceTelemetryUtcDay(now);
  return {
    day,
    shouldEmit: config.telemetry?.last_daemon_active_day !== day,
  };
}
