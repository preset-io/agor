import type { ContentBlock, ToolUse } from '@agor/core/types';

type RecordValue = Record<string, unknown>;
const MAX_PENDING_DELTAS = 256;

export type OpenCodeEventEffect =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-activity'; tool: string; status: string }
  | {
      type: 'permission';
      request: {
        id: string;
        permission: string;
        patterns: string[];
        metadata: RecordValue;
      };
    }
  | { type: 'idle' }
  | { type: 'error'; message: string };

export type OpenCodeEventTranslator = {
  translate(event: unknown): OpenCodeEventEffect[];
};

export type ReconciledOpenCodeMessage = {
  content: string;
  contentBlocks: ContentBlock[];
  toolUses: ToolUse[];
  metadata: Record<string, unknown>;
};

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function createOpenCodeEventTranslator(input: {
  sessionId: string;
  baselineMessageIds: ReadonlySet<string>;
}): OpenCodeEventTranslator {
  const messageRoles = new Map<string, string>();
  const partTypes = new Map<string, string>();
  const toolStates = new Set<string>();
  const pendingDeltas: Array<{ messageId: string; partId: string; delta: string }> = [];
  let activeAssistantSeen = false;

  const flushDeltas = (): OpenCodeEventEffect[] => {
    const effects: OpenCodeEventEffect[] = [];
    while (pendingDeltas.length > 0) {
      const pending = pendingDeltas[0];
      if (
        input.baselineMessageIds.has(pending.messageId) ||
        messageRoles.get(pending.messageId) === 'user'
      ) {
        pendingDeltas.shift();
        continue;
      }
      if (messageRoles.get(pending.messageId) !== 'assistant') break;
      const partType = partTypes.get(pending.partId);
      if (!partType) break;
      pendingDeltas.shift();
      if (partType === 'text') effects.push({ type: 'text-delta', delta: pending.delta });
      if (partType === 'reasoning') {
        effects.push({ type: 'reasoning-delta', delta: pending.delta });
      }
    }
    return effects;
  };

  return {
    translate(event: unknown): OpenCodeEventEffect[] {
      const root = record(event);
      const type = string(root?.type);
      const properties = record(root?.properties);
      if (!type || !properties) return [];

      if (type === 'message.updated') {
        const info = record(properties.info);
        if (string(info?.sessionID) !== input.sessionId) return [];
        const messageId = string(info?.id);
        const role = string(info?.role);
        if (messageId && role) messageRoles.set(messageId, role);
        if (messageId && role === 'assistant' && !input.baselineMessageIds.has(messageId)) {
          activeAssistantSeen = true;
        }
        return flushDeltas();
      }

      if (type === 'message.part.updated') {
        const part = record(properties.part);
        if (string(part?.sessionID) !== input.sessionId) return [];
        const partId = string(part?.id);
        const messageId = string(part?.messageID);
        const partType = string(part?.type);
        if (partId && partType) partTypes.set(partId, partType);
        const effects = flushDeltas();
        if (
          partType !== 'tool' ||
          !partId ||
          !messageId ||
          input.baselineMessageIds.has(messageId) ||
          messageRoles.get(messageId) !== 'assistant'
        ) {
          return effects;
        }
        const state = record(part?.state);
        const status = string(state?.status);
        const tool = string(part?.tool);
        if (!status || !tool) return effects;
        const stateKey = `${partId}:${status}`;
        if (toolStates.has(stateKey)) return effects;
        toolStates.add(stateKey);
        effects.push({ type: 'tool-activity', tool, status });
        return effects;
      }

      if (type === 'message.part.delta') {
        if (string(properties.sessionID) !== input.sessionId) return [];
        const messageId = string(properties.messageID);
        const partId = string(properties.partID);
        const delta = string(properties.delta);
        if (!messageId || !partId || !delta || properties.field !== 'text') return [];
        if (pendingDeltas.length >= MAX_PENDING_DELTAS) pendingDeltas.shift();
        pendingDeltas.push({ messageId, partId, delta });
        return flushDeltas();
      }

      if (type === 'permission.asked' || type === 'permission.updated') {
        if (string(properties.sessionID) !== input.sessionId) return [];
        const id = string(properties.id);
        const permission = string(
          type === 'permission.asked' ? properties.permission : properties.type
        );
        if (!id || !permission) return [];
        const patternValue = type === 'permission.asked' ? properties.patterns : properties.pattern;
        const patterns = Array.isArray(patternValue)
          ? patternValue.filter((value): value is string => typeof value === 'string')
          : typeof patternValue === 'string'
            ? [patternValue]
            : [];
        return [
          {
            type: 'permission',
            request: {
              id,
              permission,
              patterns,
              metadata: record(properties.metadata) ?? {},
            },
          },
        ];
      }

      if (type === 'session.status' || type === 'session.idle') {
        if (string(properties.sessionID) !== input.sessionId || !activeAssistantSeen) return [];
        const status = type === 'session.idle' ? 'idle' : string(record(properties.status)?.type);
        return status === 'idle' ? [{ type: 'idle' }] : [];
      }

      if (type === 'session.error') {
        if (string(properties.sessionID) !== input.sessionId) return [];
        const error = record(properties.error);
        const message = string(record(error?.data)?.message) ?? string(error?.message);
        return message
          ? [{ type: 'error', message }]
          : [{ type: 'error', message: 'OpenCode session failed' }];
      }

      return [];
    },
  };
}

export function reconcileOpenCodeMessages(
  messages: unknown,
  input: { sessionId: string; baselineMessageIds: ReadonlySet<string> }
): ReconciledOpenCodeMessage {
  if (!Array.isArray(messages)) {
    throw new Error('OpenCode transcript reconciliation returned an invalid message list');
  }

  const messageIds: string[] = [];
  const seenMessageIds = new Set<string>();
  const orderedParts: RecordValue[] = [];
  const partIndexes = new Map<string, number>();

  for (const value of messages) {
    const entry = record(value);
    const info = record(entry?.info);
    const messageId = string(info?.id);
    if (
      !messageId ||
      string(info?.sessionID) !== input.sessionId ||
      info?.role !== 'assistant' ||
      input.baselineMessageIds.has(messageId)
    ) {
      continue;
    }
    if (!seenMessageIds.has(messageId)) {
      seenMessageIds.add(messageId);
      messageIds.push(messageId);
    }

    const parts = entry?.parts;
    if (!Array.isArray(parts)) continue;
    for (const partValue of parts) {
      const part = record(partValue);
      if (!part) continue;
      const partType = string(part.type);
      const partId = string(part.id);
      const callId = string(part.callID);
      const key =
        partType === 'tool' && callId
          ? `tool:${callId}`
          : partId
            ? `${messageId}:part:${partId}`
            : undefined;
      if (!key) continue;
      const existingIndex = partIndexes.get(key);
      if (existingIndex === undefined) {
        partIndexes.set(key, orderedParts.length);
        orderedParts.push(part);
      } else {
        orderedParts[existingIndex] = part;
      }
    }
  }

  if (messageIds.length === 0) {
    throw new Error('OpenCode transcript reconciliation found no new assistant output');
  }

  const contentBlocks: ContentBlock[] = [];
  const toolUses: ToolUse[] = [];
  const text: string[] = [];
  const reasoningText: string[] = [];
  let hasStepMetrics = false;
  let cost = 0;
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  for (const part of orderedParts) {
    const partType = string(part.type);
    if (partType === 'text') {
      const value = string(part.text);
      if (!value) continue;
      text.push(value);
      contentBlocks.push({ type: 'text', text: value });
      continue;
    }
    if (partType === 'reasoning') {
      const value = string(part.text);
      if (value) {
        reasoningText.push(value);
        contentBlocks.push({ type: 'thinking', text: value });
      }
      continue;
    }
    if (partType === 'step-finish') {
      hasStepMetrics = true;
      cost += number(part.cost);
      const stepTokens = record(part.tokens);
      const cache = record(stepTokens?.cache);
      tokens.input += number(stepTokens?.input);
      tokens.output += number(stepTokens?.output);
      tokens.reasoning += number(stepTokens?.reasoning);
      tokens.cache.read += number(cache?.read);
      tokens.cache.write += number(cache?.write);
      continue;
    }
    if (partType !== 'tool') continue;
    const callId = string(part.callID) ?? string(part.id);
    if (!callId) continue;
    const state = record(part.state);
    const toolUse = {
      id: callId,
      name: string(part.tool) ?? 'unknown',
      input: record(state?.input) ?? {},
    };
    toolUses.push(toolUse);
    contentBlocks.push({ type: 'tool_use', ...toolUse });
    if (state?.status === 'completed' && state.output !== undefined) {
      contentBlocks.push({ type: 'tool_result', tool_use_id: callId, content: state.output });
    } else if (state?.status === 'error') {
      contentBlocks.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: string(state.error) ?? 'OpenCode tool failed',
        is_error: true,
      });
    }
  }

  if (contentBlocks.length === 0) {
    throw new Error('OpenCode transcript reconciliation found no renderable content');
  }
  const opencodeMetadata: Record<string, unknown> = { messageIds };
  if (hasStepMetrics) {
    opencodeMetadata.cost = Number(cost.toFixed(12));
    opencodeMetadata.tokens = tokens;
  }
  return {
    content: (text.length > 0 ? text : reasoningText).join('\n'),
    contentBlocks,
    toolUses,
    metadata: { opencode: opencodeMetadata },
  };
}
