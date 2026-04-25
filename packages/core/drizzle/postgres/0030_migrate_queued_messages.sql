-- Task-centric queue refactor (Section C of never-lose-prompt design) — part 2
--
-- Mirror of sqlite/0040_migrate_queued_messages.sql. Drops the legacy
-- message-level queue without backfilling: any prompts queued at daemon
-- restart can be re-issued by the caller, so we do not preserve them.
--
-- Belt-and-suspenders: a partial unique index on
-- (session_id, queue_position) WHERE status='queued' guards the new
-- `tasks.createPending` race fix at the storage layer.

-- 1. Drop legacy queued message rows.
DELETE FROM "messages" WHERE "status" = 'queued';
--> statement-breakpoint

-- 2. Drop messages.status / messages.queue_position + their composite index.
DROP INDEX IF EXISTS "messages_queue_idx";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "queue_position";--> statement-breakpoint

-- 3. Partial unique index — defense-in-depth for `tasks.createPending` race
--    serialization.
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_queued_position_unique"
  ON "tasks" ("session_id", "queue_position")
  WHERE "status" = 'queued';
