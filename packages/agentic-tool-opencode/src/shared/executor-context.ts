/**
 * Local `native-file` context: the daemon-authorized absolute XDG data home in
 * the execution home (credentials and native state share it).
 */
export interface OpenCodeNativeFileExecutorContext {
  dataHome: string;
}

/**
 * Hosted `managed-projection` context (`context/explorations/opencode-cloud.md`
 * §5). Carries only logical identity: the executor resolves every path under
 * its own `$HOME` and Job-local scratch, pulls credentials through the
 * task-scoped daemon read, and resumes the accepted checkpoint if one exists.
 */
export interface OpenCodeManagedExecutorContext {
  version: 3;
  mode: 'managed-projection';
  namespaceKey: string;
  agorSessionId: string;
  taskId: string;
}

export type OpenCodeExecutorContext =
  | OpenCodeNativeFileExecutorContext
  | OpenCodeManagedExecutorContext;

export function createOpenCodeExecutorContext(dataHome: string): OpenCodeNativeFileExecutorContext {
  if (!dataHome.trim()) throw new Error('OpenCode executor context requires a native data home');
  return { dataHome };
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createOpenCodeManagedExecutorContext(input: {
  namespaceKey: string;
  agorSessionId: string;
  taskId: string;
}): OpenCodeManagedExecutorContext {
  if (!HEX_KEY.test(input.namespaceKey)) {
    throw new Error('OpenCode managed executor context requires a namespace key');
  }
  if (!UUID.test(input.agorSessionId) || !UUID.test(input.taskId)) {
    throw new Error('OpenCode managed executor context requires session and task identity');
  }
  return {
    version: 3,
    mode: 'managed-projection',
    namespaceKey: input.namespaceKey,
    agorSessionId: input.agorSessionId,
    taskId: input.taskId,
  };
}

export function isOpenCodeManagedExecutorContext(
  context: OpenCodeExecutorContext
): context is OpenCodeManagedExecutorContext {
  return 'mode' in context && context.mode === 'managed-projection';
}

/**
 * Fail closed on anything but the exact current shapes. Legacy managed payloads
 * intentionally cannot convey accepted checkpoint authority; v3 admission
 * returns its input pin from the database ledger instead.
 */
export function parseOpenCodeExecutorContext(value: unknown): OpenCodeExecutorContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode executor context is missing');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === 'managed-projection' || candidate.version !== undefined) {
    if (
      candidate.version !== 3 ||
      candidate.mode !== 'managed-projection' ||
      Object.keys(candidate).length !== 5 ||
      typeof candidate.namespaceKey !== 'string' ||
      !HEX_KEY.test(candidate.namespaceKey) ||
      typeof candidate.agorSessionId !== 'string' ||
      !UUID.test(candidate.agorSessionId) ||
      typeof candidate.taskId !== 'string' ||
      !UUID.test(candidate.taskId)
    ) {
      throw new Error('OpenCode managed executor context is malformed');
    }
    return {
      version: 3,
      mode: 'managed-projection',
      namespaceKey: candidate.namespaceKey,
      agorSessionId: candidate.agorSessionId,
      taskId: candidate.taskId,
    };
  }
  const dataHome = candidate.dataHome;
  if (typeof dataHome !== 'string' || !dataHome.trim()) {
    throw new Error('OpenCode executor context requires a native data home');
  }
  return { dataHome };
}
