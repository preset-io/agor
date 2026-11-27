import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import type { CodexThreadRetirementPayload, ExecutorResult } from '../payload-types.js';
import { CodexAppServerClient } from '../sdk-handlers/codex/app-server-client.js';
import type { CommandOptions } from './index.js';

async function nativeThreadAbsent(
  home: string,
  threadId: string,
  DatabaseSync: typeof import('node:sqlite').DatabaseSync
): Promise<boolean> {
  const indexes = [
    ['state_5.sqlite', ['threads']],
    [
      'thread_history_1.sqlite',
      ['thread_turns', 'thread_items', 'thread_realtime_items', 'thread_history_projection_state'],
    ],
  ] as const;
  let found = false;
  for (const [file, tables] of indexes) {
    const path = join(home, file);
    const state = await lstat(path);
    if (!state.isFile() || (process.getuid && state.uid !== process.getuid())) {
      throw new Error('Unsafe native Codex index');
    }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const sidecar = await lstat(path + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (
        sidecar &&
        (!sidecar.isFile() || sidecar.uid !== state.uid || sidecar.dev !== state.dev)
      ) {
        throw new Error('Unsafe native Codex index sidecar');
      }
    }
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      if (
        file === 'state_5.sqlite' &&
        database
          .prepare(
            'SELECT 1 FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ? LIMIT 1'
          )
          .get(threadId, threadId)
      )
        throw new Error('Codex thread has spawn relationships');
      for (const table of tables) {
        const column = table === 'threads' ? 'id' : 'thread_id';
        if (database.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(threadId)) {
          found = true;
        }
      }
    } finally {
      database.close();
    }
  }
  return !found;
}

/** This is an internal executor command, reached only from scheduled retention. */
export async function handleCodexThreadRetirement(
  payload: CodexThreadRetirementPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) return { success: true, data: { dryRun: true } };
  const { branchId, codexHome, threadId } = payload.params;
  try {
    if (
      !isAbsolute(codexHome) ||
      !codexHome.endsWith(`${sep}branch-homes${sep}${branchId}${sep}codex`) ||
      (await realpath(codexHome)) !== codexHome
    ) {
      throw new Error('Unsafe Codex SDK home');
    }
    const home = await lstat(codexHome);
    if (!home.isDirectory() || (process.getuid && home.uid !== process.getuid())) {
      throw new Error('Unowned Codex SDK home');
    }
    // Verify SQLite support and the index files before issuing the effect.
    const { DatabaseSync } = await import('node:sqlite');
    await nativeThreadAbsent(codexHome, threadId, DatabaseSync);
    const client = new CodexAppServerClient({ retirementHome: codexHome });
    try {
      await client.retireThread(threadId);
    } finally {
      await client.close();
    }
    if (!(await nativeThreadAbsent(codexHome, threadId, DatabaseSync))) {
      throw new Error('Codex history remains');
    }
    return { success: true, data: { status: 'retired' } };
  } catch {
    return {
      success: false,
      error: {
        code: 'CODEX_RETIREMENT_UNCONFIRMED',
        message: 'Codex thread retirement was unconfirmed',
      },
    };
  }
}
