/**
 * Custom task events that must cross the Feathers transport boundary.
 *
 * Keep this list in sync with every custom `tasks.emit(...)` call. Standard
 * service events such as `patched` are registered by Feathers automatically.
 */
export const TASKS_SERVICE_CUSTOM_EVENTS = [
  'queued',
  'tool:start',
  'tool:complete',
  'thinking:chunk',
  'failed',
  'termination_requested',
  'mcp_refresh_requested',
] as const;
