export interface OpenCodeExecutorContext {
  dataHome: string;
}

export function createOpenCodeExecutorContext(dataHome: string): OpenCodeExecutorContext {
  if (!dataHome.trim()) throw new Error('OpenCode executor context requires a native data home');
  return { dataHome };
}

export function parseOpenCodeExecutorContext(value: unknown): OpenCodeExecutorContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode executor context is missing');
  }
  const dataHome = (value as { dataHome?: unknown }).dataHome;
  if (typeof dataHome !== 'string' || !dataHome.trim()) {
    throw new Error('OpenCode executor context requires a native data home');
  }
  return { dataHome };
}
