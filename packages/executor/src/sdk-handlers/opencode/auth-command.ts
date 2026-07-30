import {
  handleOpenCodeAuth as handlePackagedOpenCodeAuth,
  handleOpenCodeOAuth as handlePackagedOpenCodeOAuth,
  type OpenCodeOAuthExecutorEvent,
  type OpenCodeOAuthPayload,
  startManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary,
} from '@agor/agentic-tool-opencode/runtime';
import type { CommandOptions } from '../../commands/index.js';
import type { OpenCodeAuthPayload } from '../../payload-types.js';

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

export async function handleOpenCodeOAuthInteractive(
  payload: OpenCodeAuthPayload,
  options: CommandOptions,
  channel: {
    emit(event: OpenCodeOAuthExecutorEvent): void;
    read(): Promise<unknown>;
  }
) {
  if (payload.params.operation !== 'connect-oauth') {
    throw new Error('OpenCode OAuth requires a connect-oauth payload');
  }
  let codeRead = false;
  const readCode = async () => {
    if (codeRead) throw new Error('OpenCode OAuth code was already consumed');
    codeRead = true;
    const control = await channel.read();
    if (
      !control ||
      typeof control !== 'object' ||
      !('code' in control) ||
      typeof control.code !== 'string' ||
      !control.code.trim()
    ) {
      throw new Error('Invalid OpenCode OAuth code input');
    }
    return control.code;
  };
  return handleOpenCodeOAuth(payload as OpenCodeOAuthPayload, options, channel.emit, readCode);
}

export type { OpenCodeOAuthExecutorEvent, OpenCodeOAuthPayload };
