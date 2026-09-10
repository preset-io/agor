import { isOpenCodeNativeStateAttempt, type OpenCodeNativeStateAttempt } from '@agor/core/types';

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
  version: 2;
  mode: 'managed-projection';
  namespaceKey: string;
  agorSessionId: string;
  taskId: string;
  accepted: OpenCodeNativeStateAttempt | null;
}

export type OpenCodeExecutorContext =
  | OpenCodeNativeFileExecutorContext
  | OpenCodeManagedExecutorContext;

export function createOpenCodeExecutorContext(dataHome: string): OpenCodeNativeFileExecutorContext {
  if (!dataHome.trim()) throw new Error('OpenCode executor context requires a native data home');
  return { dataHome };
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createOpenCodeManagedExecutorContext(input: {
  namespaceKey: string;
  agorSessionId: string;
  taskId: string;
  accepted: OpenCodeNativeStateAttempt | null;
}): OpenCodeManagedExecutorContext {
  if (!HEX_KEY.test(input.namespaceKey)) {
    throw new Error('OpenCode managed executor context requires a namespace key');
  }
  if (!UUID.test(input.agorSessionId) || !UUID.test(input.taskId)) {
    throw new Error('OpenCode managed executor context requires session and task identity');
  }
  return {
    version: 2,
    mode: 'managed-projection',
    namespaceKey: input.namespaceKey,
    agorSessionId: input.agorSessionId,
    taskId: input.taskId,
    accepted: input.accepted,
  };
}

export function isOpenCodeManagedExecutorContext(
  context: OpenCodeExecutorContext
): context is OpenCodeManagedExecutorContext {
  return 'mode' in context && context.mode === 'managed-projection';
}

/**
 * Fail closed on anything but the two exact shapes. An executor image that only
 * understands the v1 shape throws here on a v2 payload, which is the intended
 * mixed-version behavior (daemon and executor are one release).
 */
export function parseOpenCodeExecutorContext(value: unknown): OpenCodeExecutorContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode executor context is missing');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === 'managed-projection' || candidate.version !== undefined) {
    if (
      candidate.version !== 2 ||
      candidate.mode !== 'managed-projection' ||
      typeof candidate.namespaceKey !== 'string' ||
      !HEX_KEY.test(candidate.namespaceKey) ||
      typeof candidate.agorSessionId !== 'string' ||
      !UUID.test(candidate.agorSessionId) ||
      typeof candidate.taskId !== 'string' ||
      !UUID.test(candidate.taskId) ||
      !(candidate.accepted === null || isOpenCodeNativeStateAttempt(candidate.accepted))
    ) {
      throw new Error('OpenCode managed executor context is malformed');
    }
    return {
      version: 2,
      mode: 'managed-projection',
      namespaceKey: candidate.namespaceKey,
      agorSessionId: candidate.agorSessionId,
      taskId: candidate.taskId,
      accepted: candidate.accepted as OpenCodeNativeStateAttempt | null,
    };
  }
  const dataHome = candidate.dataHome;
  if (typeof dataHome !== 'string' || !dataHome.trim()) {
    throw new Error('OpenCode executor context requires a native data home');
  }
  return { dataHome };
}
