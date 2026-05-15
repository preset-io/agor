/**
 * Shared FeathersJS service client shapes for SDK handlers.
 *
 * SDK handlers (claude / copilot / codex / gemini) talk to the daemon's
 * Feathers services through these narrow interfaces. They are deliberately
 * minimal — just the surface each handler actually calls — so handlers can
 * be tested with simple mocks instead of full Feathers app instances.
 *
 * Lives under `base/` so every provider imports from one place, rather
 * than reaching into `claude/claude-tool.ts` to grab Claude-local types.
 */

import type { Session } from '@agor/core/types';
import type { Message } from '../../types.js';

/**
 * Create and patch messages via FeathersJS. Going through the service
 * (rather than the repository directly) is what triggers WebSocket
 * broadcasts to UI clients.
 */
export interface MessagesService {
  create(data: Partial<Message>): Promise<Message>;
  patch(id: string, data: Partial<Message>): Promise<Message>;
}

/**
 * Patch tasks and emit custom WebSocket events.
 *
 * `emit` is socket.io's EventEmitter surface on the service instance — used
 * to broadcast non-CRUD events (e.g. `task.cancelled`) to UI subscribers.
 */
export interface TasksService {
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service returns dynamic task data
  get(id: string): Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS service accepts partial task updates
  patch(id: string, data: Partial<any>): Promise<any>;
  emit(event: string, data: unknown): void;
}

/**
 * Streaming task events (tool-start / tool-complete / thinking-chunk) are
 * created against a dedicated streaming service so they don't pollute the
 * task-update event stream.
 */
export interface TasksStreamingService {
  create(data: {
    event: 'tool:start' | 'tool:complete' | 'thinking:chunk';
    data: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * Patch sessions via FeathersJS. Named `SessionsPatchClient` (not
 * `SessionsService`) to avoid shadowing the canonical `SessionsService`
 * exported from `@agor/core/client`, which is a much larger surface.
 */
export interface SessionsPatchClient {
  patch(id: string, data: Partial<Session>): Promise<Session>;
}
