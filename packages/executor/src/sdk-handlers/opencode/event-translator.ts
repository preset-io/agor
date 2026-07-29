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

  const messageUpdated = (properties: RecordValue): OpenCodeEventEffect[] => {
    const info = record(properties.info);
    if (string(info?.sessionID) !== input.sessionId) return [];
    const messageId = string(info?.id);
    const role = string(info?.role);
    if (messageId && role) messageRoles.set(messageId, role);
    if (messageId && role === 'assistant' && !input.baselineMessageIds.has(messageId)) {
      activeAssistantSeen = true;
    }
    return flushDeltas();
  };

  const partUpdated = (properties: RecordValue): OpenCodeEventEffect[] => {
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
  };

  const partDelta = (properties: RecordValue): OpenCodeEventEffect[] => {
    if (string(properties.sessionID) !== input.sessionId) return [];
    const messageId = string(properties.messageID);
    const partId = string(properties.partID);
    const delta = string(properties.delta);
    if (!messageId || !partId || !delta || properties.field !== 'text') return [];
    if (pendingDeltas.length >= MAX_PENDING_DELTAS) pendingDeltas.shift();
    pendingDeltas.push({ messageId, partId, delta });
    return flushDeltas();
  };

  const permission = (
    properties: RecordValue,
    shape: 'asked' | 'updated'
  ): OpenCodeEventEffect[] => {
    if (string(properties.sessionID) !== input.sessionId) return [];
    const id = string(properties.id);
    const permissionName = string(shape === 'asked' ? properties.permission : properties.type);
    if (!id || !permissionName) return [];
    const patternValue = shape === 'asked' ? properties.patterns : properties.pattern;
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
          permission: permissionName,
          patterns,
          metadata: record(properties.metadata) ?? {},
        },
      },
    ];
  };

  const sessionStatus = (
    properties: RecordValue,
    type: 'status' | 'idle'
  ): OpenCodeEventEffect[] => {
    if (string(properties.sessionID) !== input.sessionId || !activeAssistantSeen) return [];
    const status = type === 'idle' ? 'idle' : string(record(properties.status)?.type);
    return status === 'idle' ? [{ type: 'idle' }] : [];
  };

  const sessionError = (properties: RecordValue): OpenCodeEventEffect[] => {
    if (string(properties.sessionID) !== input.sessionId) return [];
    const error = record(properties.error);
    const message = string(record(error?.data)?.message) ?? string(error?.message);
    return [{ type: 'error', message: message ?? 'OpenCode session failed' }];
  };

  const handlers = new Map<string, (properties: RecordValue) => OpenCodeEventEffect[]>([
    ['message.updated', messageUpdated],
    ['message.part.updated', partUpdated],
    ['message.part.delta', partDelta],
    ['permission.asked', (properties) => permission(properties, 'asked')],
    ['permission.updated', (properties) => permission(properties, 'updated')],
    ['session.status', (properties) => sessionStatus(properties, 'status')],
    ['session.idle', (properties) => sessionStatus(properties, 'idle')],
    ['session.error', sessionError],
  ]);

  return {
    translate(event: unknown): OpenCodeEventEffect[] {
      const root = record(event);
      const type = string(root?.type);
      const properties = record(root?.properties);
      return type && properties ? (handlers.get(type)?.(properties) ?? []) : [];
    },
  };
}

function collectAssistantParts(
  messages: unknown[],
  input: { sessionId: string; baselineMessageIds: ReadonlySet<string> }
): { messageIds: string[]; orderedParts: RecordValue[] } {
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

  return { messageIds, orderedParts };
}

type ReconciledParts = {
  contentBlocks: ContentBlock[];
  toolUses: ToolUse[];
  text: string[];
  reasoningText: string[];
  hasStepMetrics: boolean;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
};

function reconcileParts(orderedParts: RecordValue[]): ReconciledParts {
  const result: ReconciledParts = {
    contentBlocks: [],
    toolUses: [],
    text: [],
    reasoningText: [],
    hasStepMetrics: false,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };

  for (const part of orderedParts) {
    const partType = string(part.type);
    if (partType === 'text') {
      const value = string(part.text);
      if (!value) continue;
      result.text.push(value);
      result.contentBlocks.push({ type: 'text', text: value });
      continue;
    }
    if (partType === 'reasoning') {
      const value = string(part.text);
      if (value) {
        result.reasoningText.push(value);
        result.contentBlocks.push({ type: 'thinking', text: value });
      }
      continue;
    }
    if (partType === 'step-finish') {
      result.hasStepMetrics = true;
      result.cost += number(part.cost);
      const stepTokens = record(part.tokens);
      const cache = record(stepTokens?.cache);
      result.tokens.input += number(stepTokens?.input);
      result.tokens.output += number(stepTokens?.output);
      result.tokens.reasoning += number(stepTokens?.reasoning);
      result.tokens.cache.read += number(cache?.read);
      result.tokens.cache.write += number(cache?.write);
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
    result.toolUses.push(toolUse);
    result.contentBlocks.push({ type: 'tool_use', ...toolUse });
    if (state?.status === 'completed' && state.output !== undefined) {
      result.contentBlocks.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: state.output,
      });
    } else if (state?.status === 'error') {
      result.contentBlocks.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: string(state.error) ?? 'OpenCode tool failed',
        is_error: true,
      });
    }
  }

  return result;
}

export function reconcileOpenCodeMessages(
  messages: unknown,
  input: { sessionId: string; baselineMessageIds: ReadonlySet<string> }
): ReconciledOpenCodeMessage {
  if (!Array.isArray(messages)) {
    throw new Error('OpenCode transcript reconciliation returned an invalid message list');
  }

  const { messageIds, orderedParts } = collectAssistantParts(messages, input);

  if (messageIds.length === 0) {
    throw new Error('OpenCode transcript reconciliation found no new assistant output');
  }

  const reconciled = reconcileParts(orderedParts);

  if (reconciled.contentBlocks.length === 0) {
    throw new Error('OpenCode transcript reconciliation found no renderable content');
  }
  const opencodeMetadata: Record<string, unknown> = { messageIds };
  if (reconciled.hasStepMetrics) {
    opencodeMetadata.cost = Number(reconciled.cost.toFixed(12));
    opencodeMetadata.tokens = reconciled.tokens;
  }
  return {
    content: (reconciled.text.length > 0 ? reconciled.text : reconciled.reasoningText).join('\n'),
    contentBlocks: reconciled.contentBlocks,
    toolUses: reconciled.toolUses,
    metadata: { opencode: opencodeMetadata },
  };
}
