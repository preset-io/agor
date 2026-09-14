import type { OpenCodeOAuthAuthorization } from '@agor/core/types';
import {
  type ExecutorCommandResult,
  type InteractiveExecutorHandle,
  type RunExecutorCommandOptions,
  startInteractiveExecutor,
} from '../../utils/spawn-executor.js';
import { createOpenCodeExecutorInvocation } from './executor-command.js';

export type OpenCodeOAuthProcessEvent =
  | {
      type: 'authorized';
      authorization: OpenCodeOAuthAuthorization;
    }
  | { type: 'callback-started' };

export interface OpenCodeOAuthExecutorHandle {
  result: Promise<ExecutorCommandResult>;
  cancel(): Promise<ExecutorCommandResult>;
  submitCode(code: string): Promise<boolean>;
  verifyAbsence(): Promise<boolean>;
  retainContainmentFence(key: string): Promise<void>;
}

function failure(code: string, message: string, details?: unknown): ExecutorCommandResult {
  return {
    success: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
}

function parseEvent(value: unknown): OpenCodeOAuthProcessEvent | undefined {
  if (!value || typeof value !== 'object' || !('type' in value)) return undefined;
  if (value.type === 'callback-started') return { type: 'callback-started' };
  if (
    value.type !== 'authorized' ||
    !('authorization' in value) ||
    !value.authorization ||
    typeof value.authorization !== 'object'
  ) {
    return undefined;
  }

  const authorization = value.authorization as Record<string, unknown>;
  if (
    typeof authorization.url !== 'string' ||
    (authorization.method !== 'auto' && authorization.method !== 'code') ||
    typeof authorization.instructions !== 'string'
  ) {
    return undefined;
  }
  return {
    type: 'authorized',
    authorization: {
      url: authorization.url,
      method: authorization.method,
      instructions: authorization.instructions,
    },
  };
}

/**
 * OpenCode-owned adapter for the daemon's generic bounded interactive transport.
 *
 * The host owns process containment and JSON-lines framing. This adapter owns
 * OAuth event validation, code submission rules, and public-safe failures.
 */
export function startOpenCodeOAuthExecutor(
  dataHome: string,
  request: Record<string, unknown>,
  options: RunExecutorCommandOptions,
  onEvent: (event: OpenCodeOAuthProcessEvent) => void
): OpenCodeOAuthExecutorHandle {
  let codeSubmitted = false;
  let transport!: InteractiveExecutorHandle;
  transport = startInteractiveExecutor(createOpenCodeExecutorInvocation(dataHome, request), {
    ...options,
    failures: {
      localProcessRequired: failure(
        'OPENCODE_OAUTH_LOCAL_EXECUTOR_REQUIRED',
        'OpenCode OAuth requires a locally containable executor process.'
      ),
      spawn: failure('EXECUTOR_SPAWN_ERROR', 'OpenCode OAuth executor failed to start.'),
      stdin: failure(
        'OPENCODE_OAUTH_STDIN_FAILED',
        'OpenCode OAuth executor input could not be delivered.'
      ),
      timeout: failure('OPENCODE_OAUTH_TIMEOUT', 'OpenCode OAuth authorization timed out.'),
      cancelled: failure('OPENCODE_OAUTH_CANCELLED', 'OpenCode OAuth authorization was cancelled.'),
      cleanupUnverified: failure(
        'OPENCODE_OAUTH_CLEANUP_UNVERIFIED',
        'OpenCode OAuth cleanup could not be verified.'
      ),
      missingResult: (stderrSeen) =>
        failure(
          'EXECUTOR_RESULT_MISSING',
          'OpenCode OAuth executor did not deliver a final response.',
          {
            stderr: stderrSeen ? '[redacted]' : '',
          }
        ),
    },
    onEvent(value, input) {
      const event = parseEvent(value);
      if (!event) return;
      onEvent(event);
      if (event.type === 'authorized' && event.authorization.method === 'auto') {
        input.endInput();
      }
    },
  });

  return {
    result: transport.result,
    cancel: transport.cancel,
    submitCode: async (code: string) => {
      if (codeSubmitted || !code.trim()) return false;
      codeSubmitted = true;
      return transport.deliver({ code }, true);
    },
    verifyAbsence: transport.verifyAbsence,
    retainContainmentFence: transport.retainContainmentFence,
  };
}
