import { createHash } from 'node:crypto';
import type { MessageID, SessionID, TaskID } from '@agor/core/types';

function stableTaskId(sourceId: string, domain: string, discriminator = ''): TaskID {
  const digest = createHash('sha256')
    .update(`${domain}\0${sourceId}\0${discriminator}`)
    .digest('hex');
  const source = sourceId.replaceAll('-', '').toLowerCase();
  const timestampPrefix = /^[0-9a-f]{12}/.test(source) ? source.slice(0, 12) : digest.slice(0, 12);
  const compact = `${timestampPrefix}7${digest.slice(0, 19)}`.split('');
  compact[16] = ['8', '9', 'a', 'b'][Number.parseInt(digest[19] ?? '0', 16) % 4]!;
  const value = compact.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}` as TaskID;
}

/** One durable Task per source completion event and callback target. */
export function completionCallbackTaskId(sourceTaskId: TaskID, targetSessionId: SessionID): TaskID {
  return stableTaskId(sourceTaskId, 'session_completion', targetSessionId);
}

/** One durable auto-resume Task per widget message. */
export function widgetAutoResumeTaskId(widgetId: MessageID): TaskID {
  return stableTaskId(widgetId, 'widget_auto_resume');
}
