/**
 * Re-encrypt a tenant's secrets from one master key to another.
 *
 * `AGOR_MASTER_SECRET` is per process, not per tenant, so moving a tenant to
 * another install moves ciphertext its new runtime cannot read. Two uses:
 *
 * - export with a one-time transfer key: archive lines are rewritten so every
 *   secret is sealed under the transfer key, never the source install's key;
 * - `agor tenant rewrap-secrets` on the destination: live rows are rewritten
 *   from the transfer (or old) key to the runtime key.
 *
 * Discovery is by envelope FORMAT (`salt:iv:tag:data`, hex — see
 * `encryption.ts`), never by a field list: secrets live inside JSON blobs
 * whose keys change without notice. AES-GCM is authenticated, so a hex string
 * that merely looks like an envelope fails decryption and is left untouched.
 * Only the matched hex is replaced, so every other byte of a row is kept.
 */

import { is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from './client';
import { executeRaw } from './database-wrapper';
import { decryptApiKey, encryptApiKey } from './encryption';
import * as postgresSchema from './schema.postgres';
import { assertPortabilityDatabaseSupported } from './tenant-catalog';
import { buildTenantInsertOrder } from './tenant-portability-manifest';
import { runWithTenantDatabaseScope } from './tenant-scope';

const ENVELOPE = /(?<![0-9a-f:])[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*(?![0-9a-f:])/g;

export class TenantSecretRewrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantSecretRewrapError';
  }
}

export interface SecretRewrapCounts {
  scannedValues: number;
  rewrappedValues: number;
  alreadyDestinationKey: number;
}

export function emptySecretRewrapCounts(): SecretRewrapCounts {
  return { scannedValues: 0, rewrappedValues: 0, alreadyDestinationKey: 0 };
}

function readable(value: string, key: string): boolean {
  try {
    decryptApiKey(value, key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-seal every envelope in `text` that `fromKey` opens under `toKey`.
 * Envelopes already readable with `toKey` are kept (an interrupted pass
 * converges instead of double-encrypting); unreadable ones are left as is.
 */
export function rewrapEnvelopesInText(
  text: string,
  keys: { fromKey: string; toKey: string },
  counts: SecretRewrapCounts = emptySecretRewrapCounts()
): string {
  return text.replace(ENVELOPE, (match) => {
    counts.scannedValues += 1;
    if (readable(match, keys.toKey)) {
      counts.alreadyDestinationKey += 1;
      return match;
    }
    let plain: string;
    try {
      plain = decryptApiKey(match, keys.fromKey);
    } catch {
      return match;
    }
    counts.rewrappedValues += 1;
    return encryptApiKey(plain, keys.toKey);
  });
}

/** Envelopes in `text` still readable only with `fromKey`. */
export function countSourceOnlyEnvelopes(
  text: string,
  keys: { fromKey: string; toKey: string }
): number {
  let residual = 0;
  for (const match of text.match(ENVELOPE) ?? []) {
    if (readable(match, keys.fromKey) && !readable(match, keys.toKey)) residual += 1;
  }
  return residual;
}

export interface TenantSecretRewrapProof extends SecretRewrapCounts {
  tenantId: string;
  visibleRows: number;
  /** Always 0 on success: nothing remains readable only with the old key. */
  sourceKeyResidual: 0;
  tables: string[];
}

function primaryKeyColumns(tableName: string): { keys: string[]; columns: string[] } {
  for (const value of Object.values(postgresSchema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    if (config.name !== tableName) continue;
    const keys = [
      ...config.columns.filter((column) => column.primary).map((column) => column.name),
      ...config.primaryKeys.flatMap((pk) => pk.columns.map((column) => column.name)),
    ];
    return { keys, columns: config.columns.map((column) => column.name) };
  }
  return { keys: [], columns: [] };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/**
 * Rewrap one tenant's live rows (PostgreSQL) from `fromKey` to `toKey` in a
 * single tenant transaction, then prove nothing is left readable only with
 * `fromKey`. Refuses to report success when it sees no tenant rows at all
 * (indistinguishable from an RLS scope that hides them).
 */
export async function rewrapTenantSecrets(
  db: Database,
  input: { tenantId: string; fromKey: string; toKey: string }
): Promise<TenantSecretRewrapProof> {
  assertPortabilityDatabaseSupported(db);
  if (!input.fromKey || !input.toKey) {
    throw new TenantSecretRewrapError('Secret rewrap requires both keys');
  }
  const keys = { fromKey: input.fromKey, toKey: input.toKey };
  return runWithTenantDatabaseScope(db, input.tenantId, async (scoped) => {
    const counts = emptySecretRewrapCounts();
    const touched = new Set<string>();
    let visibleRows = 0;
    let residual = 0;
    for (const table of buildTenantInsertOrder()) {
      const { keys: pk, columns } = primaryKeyColumns(table.name);
      if (pk.length === 0) continue;
      const qualified = sql`${sql.identifier('public')}.${sql.identifier(table.name)}`;
      const rows = rowsOf(
        await executeRaw(
          scoped,
          sql`SELECT pg_catalog.to_jsonb(t)::pg_catalog.text AS row FROM ${qualified} t WHERE ${sql.identifier(table.tenantColumn)} = ${input.tenantId}`
        )
      );
      visibleRows += rows.length;
      const settable = columns.filter((column) => !pk.includes(column) && column !== 'tenant_id');
      for (const record of rows) {
        const text = String(record.row);
        const next = rewrapEnvelopesInText(text, keys, counts);
        if (next !== text) {
          touched.add(table.name);
          await executeRaw(
            scoped,
            sql`UPDATE ${qualified} AS t SET ${sql.join(
              settable.map(
                (column) => sql`${sql.identifier(column)} = r.${sql.identifier(column)}`
              ),
              sql`, `
            )} FROM pg_catalog.jsonb_populate_record(NULL::${qualified}, ${next}::pg_catalog.jsonb) AS r WHERE ${sql.join(
              pk.map((column) => sql`t.${sql.identifier(column)} = r.${sql.identifier(column)}`),
              sql` AND `
            )}`
          );
        }
        residual += countSourceOnlyEnvelopes(next, keys);
      }
    }
    if (visibleRows === 0) {
      throw new TenantSecretRewrapError(
        'Secret rewrap saw no tenant rows; refusing to report success'
      );
    }
    if (residual !== 0) {
      throw new TenantSecretRewrapError(
        `${residual} value(s) are still readable only with the old key`
      );
    }
    return {
      tenantId: input.tenantId,
      ...counts,
      visibleRows,
      sourceKeyResidual: 0,
      tables: [...touched].sort(),
    };
  });
}
