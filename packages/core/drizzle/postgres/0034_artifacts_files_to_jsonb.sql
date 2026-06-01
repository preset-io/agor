-- Fix regression introduced by 0032_artifacts_format_refactor: bring the
-- last three text-typed-JSON columns on `artifacts` (build_errors, files,
-- dependencies) in line with their jsonb siblings (sandpack_config,
-- required_env_vars, agor_grants, agor_runtime), all of which are now driven
-- by the canonical `t.json<T>(name)` schema helper.
--
-- Backstory: 0032 added the new declarative columns as jsonb and switched the
-- artifact repository to a `writeJson(db, value)` helper that returns raw JS
-- objects on Postgres (assuming jsonb everywhere) and JSON.stringify(value)
-- on SQLite (assuming text). The two pre-existing JSON-shaped columns
-- (`files`, `dependencies`) and `build_errors` were left as TEXT on Postgres
-- — so every publish since 0032 silently coerced JS objects into TEXT and
-- stored garbage. See PR #1147 follow-up.
--
-- The fix lifts the dialect branching out of the repo entirely: both
-- schemas now declare `t.json<T>(name)` (Postgres → jsonb, SQLite → text
-- with `mode: 'json'` so drizzle handles parse/stringify at the column
-- boundary). The repo code drops the writeJson/readJson helpers and passes
-- plain JS objects through.
--
-- USING-clause safety: we wrap the cast in a plpgsql function with an
-- EXCEPTION handler so any row whose text contents fail `::jsonb` parsing
-- (truncated JSON, accidental "[object Object]"-style coercions, etc.)
-- becomes NULL instead of aborting the whole migration. The function is
-- created and then dropped within this migration to avoid leaking helper
-- artefacts.
--
-- Note on recoverability: rows whose text was `'{}'` (the most common
-- corruption from the regression — a JS object coerced to its `String()`
-- representation, then truncated/garbled by drizzle's text binder) will
-- cast cleanly to an empty jsonb object — they are NOT NULL'd by this
-- migration, but they ARE semantically empty. The 4 rows known to be
-- corrupted during the regression window are tracked separately by their
-- `path` column and need to be re-published from their source folder.

CREATE OR REPLACE FUNCTION __agor_try_jsonb(value text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN value::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;--> statement-breakpoint

ALTER TABLE "artifacts"
  ALTER COLUMN "files" TYPE jsonb USING __agor_try_jsonb("files");--> statement-breakpoint

ALTER TABLE "artifacts"
  ALTER COLUMN "dependencies" TYPE jsonb USING __agor_try_jsonb("dependencies");--> statement-breakpoint

ALTER TABLE "artifacts"
  ALTER COLUMN "build_errors" TYPE jsonb USING __agor_try_jsonb("build_errors");--> statement-breakpoint

DROP FUNCTION __agor_try_jsonb(text);
