-- Task-centric queue refactor (Section C6 of never-lose-prompt design) — part 2
--
-- Backfill any rows in `messages` that are still pending in the legacy queue
-- (`status = 'queued'`) into the new task-centric queue (`tasks.status =
-- 'queued'`), then drop `messages.status` and `messages.queue_position`
-- columns + their composite index. The schema TS files mirror the post-state
-- (no status / queue_position on messages); after this migration runs, the
-- `MessagesRepository` queue helpers become dead code and are removed in the
-- same PR.
--
-- Pairs with postgres/0030_migrate_queued_messages.sql.

-- ---------------------------------------------------------------------------
-- 1. Backfill queued messages → queued tasks.
--    Each queued message becomes a fresh task with status='queued' carrying:
--      * the prompt as full_prompt (and a 120-char description preview)
--      * sentinel message_range / git_state — overwritten by spawnTaskExecutor
--        at the QUEUED → RUNNING transition
--      * the original metadata blob (preserves is_agor_callback, source,
--        child_session_id, child_task_id, queued_by_user_id)
--      * the queue_position copied straight across so order is preserved
--    UUIDs are generated via randomblob (good enough for an upgrade-time
--    backfill — collisions astronomically unlikely; UUID v4 layout
--    approximated, not strictly RFC compliant).
-- ---------------------------------------------------------------------------
INSERT INTO `tasks` (
  `task_id`,
  `session_id`,
  `created_at`,
  `status`,
  `queue_position`,
  `created_by`,
  `data`
)
SELECT
  lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-' ||
    '4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  m.`session_id`,
  m.`created_at`,
  'queued',
  m.`queue_position`,
  COALESCE(json_extract(m.`data`, '$.metadata.queued_by_user_id'), 'anonymous'),
  json_object(
    'description', substr(json_extract(m.`data`, '$.content'), 1, 120),
    'full_prompt', json_extract(m.`data`, '$.content'),
    'message_range', json_object(
      'start_index', -1,
      'end_index', -1,
      'start_timestamp', strftime('%Y-%m-%dT%H:%M:%fZ', m.`timestamp` / 1000.0, 'unixepoch')
    ),
    'git_state', json_object('ref_at_start', '', 'sha_at_start', ''),
    'model', 'claude-sonnet-4-6',
    'tool_use_count', 0,
    'metadata', json_extract(m.`data`, '$.metadata')
  )
FROM `messages` m
WHERE m.`status` = 'queued';
--> statement-breakpoint

-- 2. Drop the now-migrated rows so they don't survive the table rebuild as
--    orphan placeholder messages with `index = -1`.
DELETE FROM `messages` WHERE `status` = 'queued';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Drop messages.status / messages.queue_position via SQLite's table-rebuild
--    idiom (no native DROP COLUMN that survives older SQLite versions). Index
--    `messages_queue_idx` covered both columns and goes away with them.
-- ---------------------------------------------------------------------------
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP INDEX IF EXISTS `messages_queue_idx`;--> statement-breakpoint
CREATE TABLE `__new_messages` (
  `message_id` text(36) PRIMARY KEY NOT NULL,
  `created_at` integer NOT NULL,
  `session_id` text(36) NOT NULL,
  `task_id` text(36),
  `type` text NOT NULL,
  `role` text NOT NULL,
  `index` integer NOT NULL,
  `timestamp` integer NOT NULL,
  `content_preview` text,
  `parent_tool_use_id` text,
  `data` text NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_messages` (
  `message_id`, `created_at`, `session_id`, `task_id`, `type`, `role`,
  `index`, `timestamp`, `content_preview`, `parent_tool_use_id`, `data`
) SELECT
  `message_id`, `created_at`, `session_id`, `task_id`, `type`, `role`,
  `index`, `timestamp`, `content_preview`, `parent_tool_use_id`, `data`
FROM `messages`;
--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `messages_session_id_idx` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `messages_task_id_idx` ON `messages` (`task_id`);--> statement-breakpoint
CREATE INDEX `messages_session_index_idx` ON `messages` (`session_id`,`index`);
