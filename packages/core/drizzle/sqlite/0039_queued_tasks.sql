-- Task-centric queue refactor (Section C of never-lose-prompt design) — part 1
--
-- Additive migration: introduces queue_position on tasks. The status enum
-- gains a 'queued' value at the application layer (tasks.status is `text NOT
-- NULL` with no DB-level CHECK).
--
-- The follow-up migration (0040) backfills queued *messages* into queued
-- *tasks* and drops `messages.status` / `messages.queue_position` once the
-- code base no longer reads them. Splitting it lets each migration be safely
-- deployable in isolation.

ALTER TABLE `tasks` ADD `queue_position` integer;--> statement-breakpoint
CREATE INDEX `tasks_queue_idx` ON `tasks` (`session_id`,`status`,`queue_position`);
