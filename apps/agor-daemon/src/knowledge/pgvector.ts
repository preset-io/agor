import { type Database, executeRaw, isPostgresDatabase, sql } from '@agor/core/db';

export interface KnowledgePgvectorCapability {
  available: boolean;
  extensionInstalled: boolean;
  extensionAvailable: boolean;
  storageReady: boolean;
  reason: string | null;
  setupHint: string | null;
}

const SETUP_HINT =
  'Install the pgvector package on the Postgres server and have a database owner run `CREATE EXTENSION vector;`, or grant the Agor database user permission to create the extension, then re-enable/reindex Knowledge semantic search.';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function boolValue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1 || value === '1';
}

export function semanticUnavailableMessage(reason?: string | null): string {
  return `Semantic Knowledge search is unavailable${reason ? `: ${reason}` : ''}. ${SETUP_HINT}`;
}

async function readCapability(db: Database): Promise<KnowledgePgvectorCapability> {
  if (!isPostgresDatabase(db)) {
    return {
      available: false,
      extensionInstalled: false,
      extensionAvailable: false,
      storageReady: false,
      reason: 'the configured database is not PostgreSQL',
      setupHint: 'Use text Knowledge search, or switch Agor to PostgreSQL and enable pgvector.',
    };
  }

  try {
    const result = await executeRaw(
      db,
      sql`SELECT
          EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS extension_installed,
          EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS extension_available,
          to_regclass('public.kb_unit_embeddings') IS NOT NULL AS storage_ready`
    );
    const first = rowsOf(result)[0] ?? {};
    const extensionInstalled = boolValue(first.extension_installed);
    const extensionAvailable = boolValue(first.extension_available);
    const storageReady = boolValue(first.storage_ready);
    const reason = !extensionInstalled
      ? extensionAvailable
        ? 'the pgvector extension is available on the server but is not enabled in this database'
        : 'the pgvector extension is not installed on this Postgres server'
      : !storageReady
        ? 'the Knowledge vector storage table has not been created yet'
        : null;
    return {
      available: extensionInstalled && storageReady,
      extensionInstalled,
      extensionAvailable,
      storageReady,
      reason,
      setupHint: reason ? SETUP_HINT : null,
    };
  } catch (error) {
    return {
      available: false,
      extensionInstalled: false,
      extensionAvailable: false,
      storageReady: false,
      reason: `unable to inspect pgvector capability (${error instanceof Error ? error.message : String(error)})`,
      setupHint: SETUP_HINT,
    };
  }
}

export async function getKnowledgePgvectorCapability(
  db: Database
): Promise<KnowledgePgvectorCapability> {
  return readCapability(db);
}

export async function ensureKnowledgePgvectorStorage(
  db: Database
): Promise<KnowledgePgvectorCapability> {
  if (!isPostgresDatabase(db)) return readCapability(db);

  let capability = await readCapability(db);
  if (!capability.extensionInstalled) {
    try {
      await executeRaw(db, sql`CREATE EXTENSION IF NOT EXISTS vector`);
    } catch (error) {
      return {
        ...capability,
        available: false,
        reason: `pgvector could not be enabled (${error instanceof Error ? error.message : String(error)})`,
        setupHint: SETUP_HINT,
      };
    }
    capability = await readCapability(db);
    if (!capability.extensionInstalled) return capability;
  }

  try {
    await executeRaw(
      db,
      sql`CREATE TABLE IF NOT EXISTS kb_unit_embeddings (
          unit_id varchar(36) NOT NULL REFERENCES public.kb_document_units(unit_id) ON DELETE cascade,
          embedding_space_id varchar(36) NOT NULL REFERENCES public.kb_embedding_spaces(embedding_space_id) ON DELETE cascade,
          content_sha256 text NOT NULL,
          embedding vector NOT NULL,
          token_count integer,
          created_at timestamp with time zone NOT NULL,
          updated_at timestamp with time zone NOT NULL,
          CONSTRAINT kb_unit_embeddings_unit_id_embedding_space_id_pk PRIMARY KEY(unit_id, embedding_space_id)
        )`
    );
    await executeRaw(
      db,
      sql`CREATE INDEX IF NOT EXISTS kb_unit_embeddings_space_idx ON kb_unit_embeddings USING btree (embedding_space_id)`
    );

    try {
      await executeRaw(
        db,
        sql`CREATE INDEX IF NOT EXISTS kb_unit_embeddings_embedding_1536_hnsw_idx
            ON kb_unit_embeddings USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
            WHERE vector_dims(embedding) = 1536`
      );
    } catch (error) {
      console.warn(
        '[knowledge-pgvector] vector storage is available, but creating the HNSW index failed:',
        error instanceof Error ? error.message : error
      );
    }
  } catch (error) {
    return {
      ...capability,
      available: false,
      storageReady: false,
      reason: `Knowledge vector storage could not be created (${error instanceof Error ? error.message : String(error)})`,
      setupHint: SETUP_HINT,
    };
  }

  return readCapability(db);
}
