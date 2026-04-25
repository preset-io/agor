-- Task-centric queue refactor (Section C of never-lose-prompt design) — part 2
--
-- Drops the legacy message-level queue (`messages.status='queued'`,
-- `messages.queue_position`). Queued rows are simply discarded — preserving
-- them across the upgrade is not a goal: any prompts queued at daemon
-- restart can be re-issued by the caller. Pairs with
-- postgres/0030_migrate_queued_messages.sql.
--
-- Belt-and-suspenders: a partial unique index on
-- (session_id, queue_position) WHERE status='queued' guards the new
-- `tasks.createPending` race fix at the storage layer, so even if a
-- transactional read-then-insert ever slipped, the DB would reject the
-- collision instead of silently double-queuing.

-- 1. Drop legacy queued message rows. They had `index = -1` and never
--    participated in the conversation, so they're safe to discard.
DELETE FROM `messages` WHERE `status` = 'queued';
--> statement-breakpoint

-- 2. Drop messages.status / messages.queue_position via SQLite's
--    table-rebuild idiom. The composite `messages_queue_idx` covered both
--    columns and goes away with them.
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
CREATE INDEX `messages_session_index_idx` ON `messages` (`session_id`,`index`);--> statement-breakpoint

-- 3. Partial unique index — defense-in-depth for `tasks.createPending` race
--    serialization. Only QUEUED rows are constrained; CREATED/RUNNING/done
--    rows have NULL queue_position and are unaffected.
CREATE UNIQUE INDEX `tasks_queued_position_unique`
  ON `tasks` (`session_id`, `queue_position`)
  WHERE `status` = 'queued';
