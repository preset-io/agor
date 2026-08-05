import { parseOpenCodeExecutorContext } from '../shared/executor-context.js';
import {
  handleOpenCodeAuth,
  handleOpenCodeOAuth,
  type OpenCodeOAuthExecutorEvent,
} from './auth-handler.js';
import { OpenCodeAuthParamsSchema, type OpenCodeAuthPayload } from './auth-payload.js';

interface AuxiliaryInput {
  context: unknown;
  request: unknown;
  dryRun?: boolean;
}

interface InteractiveChannel {
  emit(event: unknown): void;
  read(): Promise<unknown>;
}

function payloadFor(input: AuxiliaryInput): OpenCodeAuthPayload {
  return {
    command: 'opencode.auth',
    dataHome: parseOpenCodeExecutorContext(input.context).dataHome,
    params: OpenCodeAuthParamsSchema.parse(input.request),
  };
}

async function executeInteractive(input: AuxiliaryInput, channel: InteractiveChannel) {
  const payload = payloadFor(input);
  if (payload.params.operation !== 'connect-oauth') {
    return handleOpenCodeAuth(payload, { dryRun: input.dryRun });
  }
  const oauthPayload = { ...payload, params: payload.params };

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

  return handleOpenCodeOAuth(
    oauthPayload,
    { dryRun: input.dryRun },
    (event: OpenCodeOAuthExecutorEvent) => channel.emit(event),
    readCode
  );
}

/** OpenCode-owned executor operations that do not participate in Task lifecycle. */
export const OPENCODE_AUXILIARY_ADAPTER = {
  async execute(input: AuxiliaryInput) {
    return handleOpenCodeAuth(payloadFor(input), { dryRun: input.dryRun });
  },
  executeInteractive,
} as const;
