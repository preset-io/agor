-- Task-centric queue refactor (Section C of never-lose-prompt design) — part 1
--
-- Mirror of sqlite/0039_queued_tasks.sql. Additive: introduces
-- tasks.queue_position + tasks_queue_idx. Backfill + messages-column drop
-- ships in 0029 alongside the code refactor.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "queue_position" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_queue_idx" ON "tasks" ("session_id", "status", "queue_position");
