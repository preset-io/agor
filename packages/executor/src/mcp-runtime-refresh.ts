import { randomUUID } from 'node:crypto';
import type { MCPRuntimeRefreshRequest, MCPRuntimeReprojection, TaskID } from '@agor/core/types';

export type MCPRuntimeRefreshHandler = (
  request: MCPRuntimeRefreshRequest
) => Promise<MCPRuntimeReprojection>;

const handlers = new Map<string, MCPRuntimeRefreshHandler>();
const pending = new Map<string, Promise<MCPRuntimeReprojection>>();

export function registerMCPRuntimeRefreshHandler(
  taskId: TaskID,
  handler: MCPRuntimeRefreshHandler
): () => void {
  handlers.set(taskId, handler);
  return () => {
    if (handlers.get(taskId) === handler) handlers.delete(taskId);
  };
}

/** Coalesce only an exact durable request/generation identity. */
export function requestMCPRuntimeRefresh(
  taskId: TaskID,
  input: {
    requestId?: string;
    reason: MCPRuntimeRefreshRequest['reason'];
    expectedGeneration: number;
  }
): Promise<MCPRuntimeReprojection> {
  const handler = handlers.get(taskId);
  if (!handler) return Promise.reject(new Error('Provider MCP refresh is not available'));
  const requestId = input.requestId ?? randomUUID();
  const key = `${taskId}:${input.expectedGeneration}:${requestId}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = handler({
    request_id: requestId,
    reason: input.reason,
    expected_generation: input.expectedGeneration,
  }).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}
