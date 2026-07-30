import {
  handleOpenCodeAuth as handlePackagedOpenCodeAuth,
  handleOpenCodeOAuth as handlePackagedOpenCodeOAuth,
  type OpenCodeOAuthExecutorEvent,
  type OpenCodeOAuthPayload,
  startManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary,
} from '@agor/agentic-tool-opencode/runtime';
import type { OpenCodeAuthPayload } from '../payload-types.js';
import type { CommandOptions } from './index.js';

const runtime = {
  startManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary,
};

export function handleOpenCodeAuth(payload: OpenCodeAuthPayload, options: CommandOptions) {
  return handlePackagedOpenCodeAuth(payload, options, runtime);
}

export function handleOpenCodeOAuth(
  payload: OpenCodeOAuthPayload,
  options: CommandOptions,
  emit: (event: OpenCodeOAuthExecutorEvent) => void,
  readCode?: () => Promise<string>
) {
  return handlePackagedOpenCodeOAuth(payload, options, emit, readCode, runtime);
}

export type { OpenCodeOAuthExecutorEvent, OpenCodeOAuthPayload };
