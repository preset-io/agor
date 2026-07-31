import type { SdkActivityCallback } from '../../sdk-watchdog.js';

export function isCodexReconnectEvent(event: {
  type: string;
  message?: unknown;
}): event is { type: string; message: string } {
  return (
    event.type === 'error' &&
    typeof event.message === 'string' &&
    /^Reconnecting\.\.\.\s*\d+\s*\/\s*\d+\b/.test(event.message)
  );
}

const CODEX_PROGRESS_ITEM_TYPES = new Set([
  'agent_message',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'reasoning',
  'todo_list',
  'web_search',
]);

export function reportCodexActivity(
  callback: SdkActivityCallback | undefined,
  event: {
    type: string;
    message?: unknown;
    item?: { id?: string; type?: string };
    payload?: { type?: string };
  }
): void {
  if (isCodexReconnectEvent(event)) return;

  if (
    event.type === 'item.started' ||
    event.type === 'item.updated' ||
    event.type === 'item.completed'
  ) {
    const itemType = event.item?.type ?? '';
    const itemId = event.item?.id;
    if (CODEX_PROGRESS_ITEM_TYPES.has(itemType) && itemId) {
      if (event.type === 'item.started') {
        callback?.({ type: 'operation_started', id: itemId, kind: itemType });
      } else if (event.type === 'item.updated') {
        callback?.({ type: 'operation_progress', id: itemId });
      } else {
        callback?.({ type: 'operation_finished', id: itemId });
      }
      return;
    }
    callback?.({ type: 'unknown_activity', detail: `${event.type}:${itemType || 'unknown'}` });
    return;
  }
  if (
    event.type === 'thread.started' ||
    event.type === 'turn.started' ||
    (event.type === 'event_msg' && event.payload?.type === 'turn_context')
  ) {
    callback?.({ type: 'sdk_started', detail: event.type });
    return;
  }
  if (
    event.type === 'turn.completed' ||
    event.type === 'turn.failed' ||
    event.type === 'error' ||
    (event.type === 'event_msg' &&
      ['agent_message', 'task_complete', 'turn_complete'].includes(event.payload?.type ?? ''))
  ) {
    callback?.({ type: 'progress', detail: event.type });
    return;
  }
  callback?.({ type: 'unknown_activity', detail: event.type });
}
