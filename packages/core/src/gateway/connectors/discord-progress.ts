import type { GatewayDiscordProgressState, TaskID } from '../../types';
import { isCanonicalFullUuid } from '../../types';
import { isDiscordSnowflake } from './discord-config';

export const DISCORD_PROGRESS_TOOL_NAME_MAX_BYTES = 64;
export const DISCORD_PROGRESS_MAX_REVISION = 2_147_483_647;
export const DISCORD_PROGRESS_CLEANUP_DEBT_MAX_ENTRIES = 8;

export interface DiscordProgressCleanupDebt {
  taskId: TaskID;
  providerMessageId?: string;
}

export interface DiscordProgressMetadataState {
  taskId: TaskID;
  revision: number;
  state: GatewayDiscordProgressState;
  toolName?: string;
  providerMessageId?: string;
  cleanupDebt: DiscordProgressCleanupDebt[];
}

export interface DiscordProgressMetadataAdvance {
  changed: boolean;
  metadata: Record<string, unknown>;
  progress?: DiscordProgressMetadataState;
  reason?: 'missing_task' | 'terminal_regression' | 'unchanged';
}

const STATES = new Set<GatewayDiscordProgressState>(['queued', 'working', 'failed', 'done']);
const CLEANUP_DEBT_KEY = 'discord_progress_cleanup_debt';

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Keep only a bounded tool name. Never accept a path, URL, command, or input preview. */
export function sanitizeDiscordProgressToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || !/^[A-Za-z0-9_.-]+$/.test(normalized)) return undefined;
  let bounded = normalized;
  while (bounded && utf8Bytes(bounded) > DISCORD_PROGRESS_TOOL_NAME_MAX_BYTES) {
    bounded = bounded.slice(0, -1).trimEnd();
  }
  return bounded || undefined;
}

export function parseDiscordProgressMetadata(
  metadata: Record<string, unknown>
): DiscordProgressMetadataState | undefined {
  const taskId = metadata.discord_progress_task_id;
  const revision = metadata.discord_progress_revision;
  const state = metadata.discord_progress_state;
  const toolName = metadata.discord_progress_tool_name;
  const providerMessageId = metadata.discord_progress_message_id;
  const cleanupDebt = parseDiscordProgressCleanupDebt(metadata[CLEANUP_DEBT_KEY]);
  if (
    typeof taskId !== 'string' ||
    !isCanonicalFullUuid(taskId) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision <= 0 ||
    revision > DISCORD_PROGRESS_MAX_REVISION ||
    typeof state !== 'string' ||
    !STATES.has(state as GatewayDiscordProgressState) ||
    (toolName !== undefined && sanitizeDiscordProgressToolName(toolName) !== toolName) ||
    (providerMessageId !== undefined && !isDiscordSnowflake(providerMessageId)) ||
    cleanupDebt === undefined
  ) {
    return undefined;
  }
  return {
    taskId: taskId as TaskID,
    revision,
    state: state as GatewayDiscordProgressState,
    ...(typeof toolName === 'string' ? { toolName } : {}),
    ...(typeof providerMessageId === 'string' ? { providerMessageId } : {}),
    cleanupDebt,
  };
}

function parseDiscordProgressCleanupDebt(value: unknown): DiscordProgressCleanupDebt[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DISCORD_PROGRESS_CLEANUP_DEBT_MAX_ENTRIES) {
    return undefined;
  }
  const seen = new Set<string>();
  const parsed: DiscordProgressCleanupDebt[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (
      keys.some((key) => key !== 'task_id' && key !== 'provider_message_id') ||
      typeof raw.task_id !== 'string' ||
      !isCanonicalFullUuid(raw.task_id) ||
      (raw.provider_message_id !== undefined && !isDiscordSnowflake(raw.provider_message_id)) ||
      seen.has(raw.task_id)
    ) {
      return undefined;
    }
    seen.add(raw.task_id);
    parsed.push({
      taskId: raw.task_id as TaskID,
      ...(typeof raw.provider_message_id === 'string'
        ? { providerMessageId: raw.provider_message_id }
        : {}),
    });
  }
  return parsed;
}

function writeDiscordProgressCleanupDebt(
  metadata: Record<string, unknown>,
  cleanupDebt: readonly DiscordProgressCleanupDebt[]
): Record<string, unknown> {
  const next = { ...metadata };
  if (cleanupDebt.length === 0) {
    delete next[CLEANUP_DEBT_KEY];
  } else {
    next[CLEANUP_DEBT_KEY] = cleanupDebt.map((debt) => ({
      task_id: debt.taskId,
      ...(debt.providerMessageId ? { provider_message_id: debt.providerMessageId } : {}),
    }));
  }
  return next;
}

/** Add or enrich one stable-nonce cleanup coordinate without growing unbounded state. */
export function addDiscordProgressCleanupDebt(
  metadata: Record<string, unknown>,
  debt: DiscordProgressCleanupDebt
): Record<string, unknown> {
  if (
    !isCanonicalFullUuid(debt.taskId) ||
    (debt.providerMessageId !== undefined && !isDiscordSnowflake(debt.providerMessageId))
  ) {
    throw new Error('Invalid Discord progress cleanup coordinate');
  }
  const progress = parseDiscordProgressMetadata(metadata);
  if (!progress) throw new Error('Invalid Discord progress metadata');
  const cleanupDebt = [...progress.cleanupDebt];
  const existing = cleanupDebt.findIndex((item) => item.taskId === debt.taskId);
  if (existing >= 0) {
    cleanupDebt[existing] = {
      taskId: debt.taskId,
      ...(debt.providerMessageId
        ? { providerMessageId: debt.providerMessageId }
        : cleanupDebt[existing]?.providerMessageId
          ? { providerMessageId: cleanupDebt[existing].providerMessageId }
          : {}),
    };
  } else {
    if (cleanupDebt.length >= DISCORD_PROGRESS_CLEANUP_DEBT_MAX_ENTRIES) {
      throw new Error('Discord progress cleanup debt is full');
    }
    cleanupDebt.push(debt);
  }
  return writeDiscordProgressCleanupDebt(metadata, cleanupDebt);
}

/** Remove only the exact coordinate that was actually cleaned. */
export function removeDiscordProgressCleanupDebt(
  metadata: Record<string, unknown>,
  debt: DiscordProgressCleanupDebt
): { metadata: Record<string, unknown>; removed: boolean } {
  const progress = parseDiscordProgressMetadata(metadata);
  if (!progress) return { metadata, removed: false };
  const index = progress.cleanupDebt.findIndex(
    (item) =>
      item.taskId === debt.taskId &&
      (item.providerMessageId ?? null) === (debt.providerMessageId ?? null)
  );
  if (index < 0) return { metadata, removed: false };
  const cleanupDebt = [...progress.cleanupDebt];
  cleanupDebt.splice(index, 1);
  return { metadata: writeDiscordProgressCleanupDebt(metadata, cleanupDebt), removed: true };
}

/**
 * Monotonically update only the sanitized Discord activity fields.
 *
 * Terminal state for the same task cannot regress. A provider handle is never
 * transferred across tasks: terminal/task switches move it (or the task's
 * stable create nonce) into bounded cleanup debt for owner execution.
 */
export function advanceDiscordProgressMetadata(
  metadata: Record<string, unknown>,
  input: {
    taskId?: TaskID;
    state: GatewayDiscordProgressState;
    toolName?: unknown;
  }
): DiscordProgressMetadataAdvance {
  const current = parseDiscordProgressMetadata(metadata);
  const taskId = input.taskId ?? current?.taskId;
  if (!taskId) return { changed: false, metadata, reason: 'missing_task' };

  const sameTask = current?.taskId === taskId;
  if (
    sameTask &&
    ((current.state === 'done' && input.state !== 'done') ||
      (current.state === 'failed' && (input.state === 'queued' || input.state === 'working')))
  ) {
    return { changed: false, metadata, progress: current, reason: 'terminal_regression' };
  }

  const sanitizedToolName =
    input.state === 'working'
      ? (sanitizeDiscordProgressToolName(input.toolName) ??
        (sameTask ? current.toolName : undefined))
      : undefined;
  let next = { ...metadata };
  let cleanupDebt = current?.cleanupDebt ?? [];
  const mustRetireCurrent =
    !!current &&
    ((sameTask && input.state === 'done' && current.state !== 'done') ||
      (!sameTask && (current.state !== 'done' || !!current.providerMessageId)));
  if (mustRetireCurrent && current) {
    next = addDiscordProgressCleanupDebt(next, {
      taskId: current.taskId,
      ...(current.providerMessageId ? { providerMessageId: current.providerMessageId } : {}),
    });
    cleanupDebt = parseDiscordProgressMetadata(next)?.cleanupDebt ?? cleanupDebt;
  }
  if (
    sameTask &&
    current.state === input.state &&
    current.toolName === sanitizedToolName &&
    !(input.state === 'done' && current.providerMessageId)
  ) {
    return { changed: false, metadata, progress: current, reason: 'unchanged' };
  }

  const previousRevision = current?.revision ?? 0;
  if (previousRevision >= DISCORD_PROGRESS_MAX_REVISION) {
    throw new Error('Discord progress revision exhausted');
  }
  const revision = previousRevision + 1;
  const progress: DiscordProgressMetadataState = {
    taskId,
    revision,
    state: input.state,
    ...(sanitizedToolName ? { toolName: sanitizedToolName } : {}),
    ...(sameTask && input.state !== 'done' && current?.providerMessageId
      ? { providerMessageId: current.providerMessageId }
      : {}),
    cleanupDebt,
  };
  next.discord_progress_task_id = progress.taskId;
  next.discord_progress_revision = progress.revision;
  next.discord_progress_state = progress.state;
  if (progress.toolName) next.discord_progress_tool_name = progress.toolName;
  else delete next.discord_progress_tool_name;
  if (progress.providerMessageId) next.discord_progress_message_id = progress.providerMessageId;
  else delete next.discord_progress_message_id;
  next = writeDiscordProgressCleanupDebt(next, progress.cleanupDebt);
  return { changed: true, metadata: next, progress };
}

/** Stable across config revisions and owner takeover for Discord enforce_nonce replay. */
export function discordProgressNonceSeed(mappingId: string, taskId: string): string {
  if (!isCanonicalFullUuid(mappingId) || !isCanonicalFullUuid(taskId)) {
    throw new Error('Canonical mapping and task IDs are required for Discord progress nonce');
  }
  return `discord-progress:${mappingId}:${taskId}`;
}
