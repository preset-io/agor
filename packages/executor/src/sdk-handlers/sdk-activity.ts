import type { ExecutorPulseKind } from '@agor/core/types';

export type SdkActivityAdapter = 'claude-code' | 'codex' | 'gemini' | 'copilot' | 'opencode';
export type SdkActivityCallback = (kind: ExecutorPulseKind, detail?: string) => void;

export const SDK_ACTIVITY_VERSION_MANIFEST: Record<SdkActivityAdapter, string> = {
  'claude-code': '@anthropic-ai/claude-agent-sdk@0.3.197',
  codex: '@openai/codex-sdk@0.144.0',
  gemini: '@google/gemini-cli-core@0.31.0',
  copilot: '@github/copilot-sdk@0.2.2',
  opencode: '@opencode-ai/sdk@1.14.33',
};

export function getSdkActivityVersion(adapter: string): string | undefined {
  return SDK_ACTIVITY_VERSION_MANIFEST[adapter as SdkActivityAdapter];
}

const STARTED = new Set([
  'claude-code:system',
  'codex:thread.started',
  'codex:turn.started',
  'codex:event_msg.turn_context',
  'gemini:model_info',
  'copilot:assistant.turn_start',
  'opencode:permission.updated',
]);
const WAITING = new Set([
  'claude-code:permission.request',
  'claude-code:user_input.request',
  'copilot:permission.request',
  'copilot:user_input.request',
  'gemini:tool_call_confirmation',
  'opencode:permission.asked',
]);
const PROGRESS = new Set([
  'claude-code:assistant',
  'claude-code:stream_event',
  'claude-code:user',
  'claude-code:result',
  'codex:item.started',
  'codex:item.updated',
  'codex:item.completed',
  'codex:turn.completed',
  'codex:event_msg.agent_message',
  'codex:event_msg.task_complete',
  'codex:event_msg.turn_complete',
  'gemini:content',
  'gemini:thought',
  'gemini:tool_call_request',
  'gemini:tool_call_response',
  'gemini:finished',
  'copilot:assistant.message_delta',
  'copilot:assistant.reasoning_delta',
  'copilot:tool.execution_start',
  'copilot:tool.execution_complete',
  'copilot:subagent.started',
  'copilot:subagent.completed',
  'copilot:assistant.turn_end',
  'opencode:message.updated',
  'opencode:message.part.updated',
  'opencode:session.status',
]);

function boundedDetail(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

export function mapSdkActivity(
  adapter: SdkActivityAdapter,
  discriminator: string
): { kind: ExecutorPulseKind; detail: string } | undefined {
  if (adapter === 'opencode' && discriminator === 'server.heartbeat') return undefined;

  const detail = boundedDetail(discriminator);
  const key = `${adapter}:${detail}`;
  if (WAITING.has(key)) return { kind: 'waiting', detail };
  if (STARTED.has(key)) return { kind: 'sdk_started', detail };
  if (PROGRESS.has(key)) return { kind: 'progress', detail };
  return { kind: 'unknown_activity', detail };
}

export function reportSdkActivity(
  callback: SdkActivityCallback | undefined,
  adapter: SdkActivityAdapter,
  discriminator: string
): void {
  const pulse = mapSdkActivity(adapter, discriminator);
  if (pulse) callback?.(pulse.kind, pulse.detail);
}
