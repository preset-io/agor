import { describe, expect, it } from 'vitest';
import {
  addDiscordProgressCleanupDebt,
  advanceDiscordProgressMetadata,
  discordProgressNonceSeed,
  parseDiscordProgressMetadata,
  removeDiscordProgressCleanupDebt,
  sanitizeDiscordProgressToolName,
} from './discord-progress';

const task = '01927f9d-1000-7000-8000-000000000004' as never;
const mapping = '01927f9d-1000-7000-8000-000000000002';

describe('Discord progress state', () => {
  it('persists only bounded tool names and deterministic canonical nonce input', () => {
    expect(sanitizeDiscordProgressToolName('mcp__server__tool')).toBe('mcp__server__tool');
    expect(sanitizeDiscordProgressToolName('https://secret.invalid/input')).toBeUndefined();
    expect(sanitizeDiscordProgressToolName('/home/secret')).toBeUndefined();
    expect(discordProgressNonceSeed(mapping, task)).toBe(`discord-progress:${mapping}:${task}`);
    expect(() => discordProgressNonceSeed('short', task)).toThrow(/Canonical/);
  });

  it('advances monotonically, preserves unrelated metadata, and rejects terminal regression', () => {
    const working = advanceDiscordProgressMetadata(
      { concurrent_provider_key: 'retained' },
      { taskId: task, state: 'working', toolName: 'Bash' }
    );
    expect(working.progress).toMatchObject({
      taskId: task,
      revision: 1,
      state: 'working',
      toolName: 'Bash',
    });
    expect(working.metadata.concurrent_provider_key).toBe('retained');

    const done = advanceDiscordProgressMetadata(working.metadata, {
      taskId: task,
      state: 'done',
    });
    expect(done.progress).toMatchObject({ revision: 2, state: 'done' });
    const lateWorking = advanceDiscordProgressMetadata(done.metadata, {
      taskId: task,
      state: 'working',
      toolName: 'Read',
    });
    expect(lateWorking).toMatchObject({ changed: false, reason: 'terminal_regression' });
    expect(parseDiscordProgressMetadata(lateWorking.metadata)).toMatchObject({
      revision: 2,
      state: 'done',
    });
  });

  it('never transfers a temporary handle to a newer task', () => {
    const nextTask = '01927f9d-1000-7000-8000-000000000005' as never;
    const next = advanceDiscordProgressMetadata(
      {
        discord_progress_task_id: task,
        discord_progress_revision: 3,
        discord_progress_state: 'failed',
        discord_progress_message_id: '823456789012345678',
      },
      { taskId: nextTask, state: 'queued' }
    );
    expect(next.progress).toMatchObject({ taskId: nextTask, revision: 4, state: 'queued' });
    expect(next.metadata.discord_progress_message_id).toBeUndefined();
    expect(next.progress?.cleanupDebt).toEqual([
      { taskId: task, providerMessageId: '823456789012345678' },
    ]);
  });

  it('moves a same-task terminal handle into cleanup debt', () => {
    const done = advanceDiscordProgressMetadata(
      {
        discord_progress_task_id: task,
        discord_progress_revision: 3,
        discord_progress_state: 'working',
        discord_progress_message_id: '823456789012345678',
      },
      { taskId: task, state: 'done' }
    );
    expect(done.progress).toMatchObject({ taskId: task, revision: 4, state: 'done' });
    expect(done.progress?.providerMessageId).toBeUndefined();
    expect(done.progress?.cleanupDebt).toEqual([
      { taskId: task, providerMessageId: '823456789012345678' },
    ]);
  });

  it('strictly validates and bounds provider cleanup coordinates', () => {
    const base = advanceDiscordProgressMetadata({}, { taskId: task, state: 'working' }).metadata;
    expect(
      parseDiscordProgressMetadata({
        ...base,
        discord_progress_message_id: 'not-a-snowflake',
      })
    ).toBeUndefined();
    expect(
      parseDiscordProgressMetadata({
        ...base,
        discord_progress_cleanup_debt: [{ task_id: task, provider_message_id: 'not-a-snowflake' }],
      })
    ).toBeUndefined();

    let metadata = base;
    for (let index = 0; index < 8; index += 1) {
      const taskId = `01927f9d-1000-7000-8000-0000000000${10 + index}` as never;
      metadata = addDiscordProgressCleanupDebt(metadata, { taskId });
    }
    expect(parseDiscordProgressMetadata(metadata)?.cleanupDebt).toHaveLength(8);
    expect(() =>
      addDiscordProgressCleanupDebt(metadata, {
        taskId: '01927f9d-1000-7000-8000-000000000099' as never,
      })
    ).toThrow(/full/);
    const debt = parseDiscordProgressMetadata(metadata)?.cleanupDebt[0];
    expect(debt).toBeDefined();
    const removed = removeDiscordProgressCleanupDebt(metadata, debt!);
    expect(removed.removed).toBe(true);
    expect(parseDiscordProgressMetadata(removed.metadata)?.cleanupDebt).toHaveLength(7);
  });
});
