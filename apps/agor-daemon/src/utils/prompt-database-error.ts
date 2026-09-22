import { randomUUID } from 'node:crypto';
import { getPostgresSqlState } from '@agor/core/db';
import { Unavailable } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';

function causes(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  while (error && typeof error === 'object' && chain.length < 8) {
    const item = error as Record<string, unknown>;
    if (chain.includes(item)) break;
    chain.push(item);
    error = item.cause;
  }
  return chain;
}

const safeFailures = new WeakSet<object>();
const driverCodes = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_ERROR',
  'SQLITE_CONSTRAINT',
]);

function isDatabaseError(error: unknown): boolean {
  return (
    getPostgresSqlState(error) !== undefined ||
    causes(error).some(
      (item) =>
        (typeof item.query === 'string' && Array.isArray(item.params)) ||
        (typeof item.code === 'string' && driverCodes.has(item.code))
    )
  );
}

/** Curated diagnostics only: driver messages, detail, query, params and stacks may contain secrets. */
export function safePromptDatabaseFailure(
  error: unknown,
  elapsedMs: number,
  admission?: {
    attempt: number;
    phase: 'acquisition_or_setup' | 'statement' | 'commit_or_after_commit';
    acquisitionSetupMs?: number;
  }
): Error {
  const reference = randomUUID();
  const chain = causes(error);
  const driverCode = chain
    .map((item) => item.code)
    .find((code) => typeof code === 'string' && driverCodes.has(code));
  // Only classify known row-lock targets; never serialize the query itself.
  const lockTable = chain
    .map((item) =>
      typeof item.query === 'string'
        ? /^SELECT 1 FROM "(branches|sessions|tasks)" WHERE [\s\S]* FOR UPDATE$/.exec(
            item.query
          )?.[1]
        : undefined
    )
    .find(Boolean);
  // PostgreSQL deadlock detail also contains arbitrary query text. Retain only
  // the numeric wait edges, enough to correlate with restricted server logs.
  const deadlockEdges =
    getPostgresSqlState(error) === '40P01'
      ? chain
          .flatMap((item) =>
            typeof item.detail === 'string'
              ? [
                  ...item.detail
                    .slice(0, 4096)
                    .matchAll(
                      /Process (\d{1,10}) waits for ShareLock on transaction (\d{1,20}); blocked by process (\d{1,10})\./g
                    ),
                ].map((match) => `${match[1]}:${match[2]}:${match[3]}`)
              : []
          )
          .slice(0, 4)
          .join(',')
      : '';
  console.error(
    `[prompt.database] failed reference=${reference} sqlstate=${getPostgresSqlState(error) ?? 'unknown'} driver_code=${driverCode ?? 'unknown'} elapsed_ms=${Math.max(0, Math.round(elapsedMs))} deadlock_edges=${deadlockEdges || 'unknown'} lock_table=${lockTable ?? 'unknown'} attempt=${admission?.attempt ?? 'unknown'} phase=${admission?.phase ?? 'prompt_route'} acquisition_setup_ms=${admission?.acquisitionSetupMs ?? 'unknown'} outcome=unconfirmed`
  );
  const failure = new Unavailable(
    `Could not confirm prompt admission. Check the session before sending again. Reference: ${reference}.`,
    { reference }
  );
  Object.defineProperty(failure, 'cause', { value: error });
  safeFailures.add(failure);
  return failure;
}

/** Outermost prompt-only boundary, including gate checks and post-admission work. Never replays work. */
export async function promptDatabaseErrorAround(
  _context: HookContext,
  next: () => Promise<void>
): Promise<void> {
  const started = performance.now();
  try {
    await next();
  } catch (error) {
    if (error && typeof error === 'object' && safeFailures.has(error)) throw error;
    if (!isDatabaseError(error)) throw error;
    throw safePromptDatabaseFailure(error, performance.now() - started);
  }
}
