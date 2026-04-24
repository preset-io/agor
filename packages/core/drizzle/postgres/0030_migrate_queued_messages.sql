-- Task-centric queue refactor (Section C6 of never-lose-prompt design) — part 2
--
-- Mirror of sqlite/0040_migrate_queued_messages.sql. Backfills queued messages
-- into queued tasks, then drops `messages.status` and `messages.queue_position`
-- columns + their composite index. Pairs with the schema TS file changes that
-- remove these columns.

-- ---------------------------------------------------------------------------
-- 1. Backfill queued messages → queued tasks. See sqlite mirror for the
--    rationale (sentinels are overwritten by spawnTaskExecutor at QUEUED →
--    RUNNING; metadata blob preserves is_agor_callback / source / child IDs /
--    queued_by_user_id).
--    `gen_random_uuid()` is built into PostgreSQL 13+; this project requires it.
-- ---------------------------------------------------------------------------
INSERT INTO "tasks" (
  "task_id",
  "session_id",
  "created_at",
  "status",
  "queue_position",
  "created_by",
  "data"
)
SELECT
  gen_random_uuid()::text,
  m."session_id",
  m."created_at",
  'queued',
  m."queue_position",
  COALESCE(m."data"->'metadata'->>'queued_by_user_id', 'anonymous'),
  jsonb_build_object(
    'description', substr(m."data"->>'content', 1, 120),
    'full_prompt', m."data"->>'content',
    'message_range', jsonb_build_object(
      'start_index', -1,
      'end_index', -1,
      'start_timestamp', to_char(m."timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'git_state', jsonb_build_object('ref_at_start', '', 'sha_at_start', ''),
    'model', 'claude-sonnet-4-6',
    'tool_use_count', 0,
    'metadata', m."data"->'metadata'
  )
FROM "messages" m
WHERE m."status" = 'queued';
--> statement-breakpoint

-- 2. Drop the migrated rows so they don't linger as orphan placeholders
--    (they had `index = -1`, never participated in the conversation).
DELETE FROM "messages" WHERE "status" = 'queued';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Drop messages.status / messages.queue_position + their composite index.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "messages_queue_idx";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "queue_position";
