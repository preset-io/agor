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
-- USING-clause safety: legitimate rows hold valid JSON strings (or NULL) and
-- cast cleanly. Broken rows created between 0032 deploy and this migration
-- may contain garbage from the object→text coercion; the defensive CASE
-- NULLs anything that doesn't start with a JSON object/array character so
-- the migration never aborts. Affected rows need to be re-published from
-- their `path` source folder afterward to recover their content.

ALTER TABLE "artifacts"
  ALTER COLUMN "files" TYPE jsonb
  USING (
    CASE
      WHEN "files" IS NULL THEN NULL::jsonb
      WHEN "files" ~ '^\s*[{\[]' THEN "files"::jsonb
      ELSE NULL::jsonb
    END
  );--> statement-breakpoint

ALTER TABLE "artifacts"
  ALTER COLUMN "dependencies" TYPE jsonb
  USING (
    CASE
      WHEN "dependencies" IS NULL THEN NULL::jsonb
      WHEN "dependencies" ~ '^\s*[{\[]' THEN "dependencies"::jsonb
      ELSE NULL::jsonb
    END
  );--> statement-breakpoint

ALTER TABLE "artifacts"
  ALTER COLUMN "build_errors" TYPE jsonb
  USING (
    CASE
      WHEN "build_errors" IS NULL THEN NULL::jsonb
      WHEN "build_errors" ~ '^\s*[{\[]' THEN "build_errors"::jsonb
      ELSE NULL::jsonb
    END
  );
