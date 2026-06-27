import { describe, expect, it } from 'vitest';
import { shouldEmitOpenSourceTelemetryDaemonActive } from './open-source-telemetry-heartbeat.js';

describe('open-source telemetry daemon heartbeat', () => {
  it('emits daemon.active at most once per UTC day', () => {
    expect(
      shouldEmitOpenSourceTelemetryDaemonActive(
        { telemetry: { last_daemon_active_day: '2026-06-26' } },
        new Date('2026-06-27T00:01:00.000Z')
      )
    ).toEqual({ day: '2026-06-27', shouldEmit: true });

    expect(
      shouldEmitOpenSourceTelemetryDaemonActive(
        { telemetry: { last_daemon_active_day: '2026-06-27' } },
        new Date('2026-06-27T23:59:00.000Z')
      )
    ).toEqual({ day: '2026-06-27', shouldEmit: false });
  });
});
