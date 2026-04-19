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

ALTER TABLE `worktrees` ADD `environment_variant` text;
--> statement-breakpoint

-- Wrap legacy environment_config as environment.variants.default (v2).
-- Only touches rows where `environment_config` exists and `environment` is
-- not yet present, so this migration is idempotent.
UPDATE `repos`
SET `data` = json_set(
  `data`,
  '$.environment',
  json_object(
    'version', 2,
    'default', 'default',
    'variants', json_object(
      'default', json_object(
        'start', json_extract(`data`, '$.environment_config.up_command'),
        'stop',  json_extract(`data`, '$.environment_config.down_command'),
        'nuke',  json_extract(`data`, '$.environment_config.nuke_command'),
        'logs',  json_extract(`data`, '$.environment_config.logs_command'),
        'health', json_extract(`data`, '$.environment_config.health_check.url_template'),
        'app',   json_extract(`data`, '$.environment_config.app_url_template')
      )
    )
  )
)
WHERE json_type(`data`, '$.environment_config') IS NOT NULL
  AND json_type(`data`, '$.environment') IS NULL;
