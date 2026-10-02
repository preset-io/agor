/** Local native-file context: the daemon-authorized XDG data home in the execution home. */
export interface OpenCodeNativeFileExecutorContext {
  dataHome: string;
}

/** Hosted context: logical identity only; the executor resolves paths under its own home and scratch. */
export interface OpenCodeManagedExecutorContext {
  mode: 'managed';
  sessionId: string;
  taskId: string;
}

export type OpenCodeExecutorContext =
  | OpenCodeNativeFileExecutorContext
  | OpenCodeManagedExecutorContext;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createOpenCodeExecutorContext(dataHome: string): OpenCodeNativeFileExecutorContext {
  if (!dataHome.trim()) throw new Error('OpenCode executor context requires a native data home');
  return { dataHome };
}

export function createOpenCodeManagedExecutorContext(
  sessionId: string,
  taskId: string
): OpenCodeManagedExecutorContext {
  if (!UUID.test(sessionId) || !UUID.test(taskId)) {
    throw new Error('OpenCode managed executor context requires session and task identity');
  }
  return { mode: 'managed', sessionId, taskId };
}

export function isOpenCodeManagedExecutorContext(
  context: OpenCodeExecutorContext
): context is OpenCodeManagedExecutorContext {
  return 'mode' in context;
}

export function parseOpenCodeExecutorContext(value: unknown): OpenCodeExecutorContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode executor context is missing');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== undefined) {
    if (
      candidate.mode !== 'managed' ||
      Object.keys(candidate).length !== 3 ||
      typeof candidate.sessionId !== 'string' ||
      typeof candidate.taskId !== 'string'
    ) {
      throw new Error('OpenCode managed executor context is malformed');
    }
    return createOpenCodeManagedExecutorContext(candidate.sessionId, candidate.taskId);
  }
  const dataHome = candidate.dataHome;
  if (typeof dataHome !== 'string' || !dataHome.trim()) {
    throw new Error('OpenCode executor context requires a native data home');
  }
  return { dataHome };
}
