import type { JwtPayload } from 'jsonwebtoken';

export const EXECUTOR_SESSION_TOKEN_TYPE = 'executor-session';
export const EXECUTOR_SESSION_TOKEN_PURPOSE = 'executor-task';
export const EXECUTOR_COMMAND_TOKEN_PURPOSE = 'executor-command';

export type ExecutorTokenPurpose =
  | typeof EXECUTOR_SESSION_TOKEN_PURPOSE
  | typeof EXECUTOR_COMMAND_TOKEN_PURPOSE;

export type ExecutorSessionTokenPayload = JwtPayload & {
  type?: string;
  purpose?: string;
  session_id?: string;
  /** @deprecated Legacy alias kept only for tokens minted before session_id became canonical. */
  sessionId?: string;
  task_id?: string;
  branch_id?: string;
};

export type AuthenticatedExecutorSessionTokenPayload = ExecutorSessionTokenPayload & {
  type: typeof EXECUTOR_SESSION_TOKEN_TYPE;
  purpose: ExecutorTokenPurpose;
};

/** Durable executor-token authority that has just been revoked. */
export interface ExecutorSessionTokenRevocation {
  tenantId?: string;
  tokenFingerprint: string;
}

export function isExecutorSessionTokenPayload(
  payload: unknown
): payload is AuthenticatedExecutorSessionTokenPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as ExecutorSessionTokenPayload;
  return (
    record.type === EXECUTOR_SESSION_TOKEN_TYPE &&
    (record.purpose === EXECUTOR_SESSION_TOKEN_PURPOSE ||
      record.purpose === EXECUTOR_COMMAND_TOKEN_PURPOSE)
  );
}

export function getExecutorSessionTokenSessionId(
  payload: ExecutorSessionTokenPayload
): string | undefined {
  return payload.session_id ?? payload.sessionId;
}
