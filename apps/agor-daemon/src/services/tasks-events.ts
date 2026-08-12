/**
 * Custom task events that must cross the Feathers transport boundary.
 *
 * Keep this list in sync with every custom `tasks.emit(...)` call. Standard
 * service events such as `patched` are registered by Feathers automatically.
 */
export const TASK_STREAMING_EVENT_TYPES = [
  'tool:start',
  'tool:complete',
  'thinking:chunk',
] as const;

export type TaskStreamingEventType = (typeof TASK_STREAMING_EVENT_TYPES)[number];

export const TASKS_SERVICE_CUSTOM_EVENTS = [
  'queued',
  ...TASK_STREAMING_EVENT_TYPES,
  'failed',
  'termination_requested',
] as const;
