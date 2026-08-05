import type { ExecutorPulseKind } from '@agor/core/types';

const STARTED = new Set(['permission.updated']);
const WAITING = new Set(['permission.asked']);
const PROGRESS = new Set(['message.updated', 'message.part.updated', 'session.status']);

function boundedDetail(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

export function mapOpenCodeActivity(
  discriminator: string
): { kind: ExecutorPulseKind; detail: string } | undefined {
  if (discriminator === 'server.heartbeat') return undefined;
  const detail = boundedDetail(discriminator);
  if (WAITING.has(detail)) return { kind: 'waiting', detail };
  if (STARTED.has(detail)) return { kind: 'sdk_started', detail };
  if (PROGRESS.has(detail)) return { kind: 'progress', detail };
  return { kind: 'unknown_activity', detail };
}

export function reportOpenCodeActivity(
  callback: ((kind: ExecutorPulseKind, detail?: string) => void) | undefined,
  discriminator: string
): void {
  const pulse = mapOpenCodeActivity(discriminator);
  if (pulse) callback?.(pulse.kind, pulse.detail);
}
