-- Env command variants (v2)
--
-- 1. Adds `worktrees.environment_variant` column to track the currently
--    rendered variant name per worktree.
--
-- 2. Wraps any existing `repos.data.environment_config` legacy blob as a v2
--    environment with a single "default" variant, preserving the original
--    `environment_config` JSON in place for UI back-compat.
--
-- See docs/designs/env-command-variants.md.

ALTER TABLE "worktrees" ADD COLUMN "environment_variant" text;
--> statement-breakpoint

-- Wrap legacy environment_config as environment.variants.default (v2).
-- Only touches rows where `environment_config` exists and `environment` is
-- not yet present, so this migration is idempotent.
UPDATE "repos"
SET "data" = jsonb_set(
  "data"::jsonb,
  '{environment}',
  jsonb_build_object(
    'version', 2,
    'default', 'default',
    'variants', jsonb_build_object(
      'default', jsonb_strip_nulls(
        jsonb_build_object(
          'start',  "data"->'environment_config'->>'up_command',
          'stop',   "data"->'environment_config'->>'down_command',
          'nuke',   "data"->'environment_config'->>'nuke_command',
          'logs',   "data"->'environment_config'->>'logs_command',
          'health', "data"->'environment_config'->'health_check'->>'url_template',
          'app',    "data"->'environment_config'->>'app_url_template'
        )
      )
    )
  ),
  true
)::json
WHERE "data" ? 'environment_config'
  AND NOT ("data" ? 'environment');
