-- Partial unique index on (schedule_id, scheduled_run_at) for non-null
-- schedule_id rows. Closes a check-then-create race in the scheduler.
-- See SQLite mirror for the full rationale.

DELETE FROM "sessions"
WHERE schedule_id IS NOT NULL
  AND session_id NOT IN (
    SELECT session_id
    FROM (
      SELECT
        session_id,
        ROW_NUMBER() OVER (
          PARTITION BY schedule_id, scheduled_run_at
          ORDER BY session_id DESC
        ) AS rn
      FROM "sessions"
      WHERE schedule_id IS NOT NULL
    ) AS ranked
    WHERE rn = 1
  );--> statement-breakpoint

DROP INDEX IF EXISTS "sessions_schedule_id_idx";--> statement-breakpoint

CREATE UNIQUE INDEX "sessions_schedule_run_unique" ON "sessions" ("schedule_id", "scheduled_run_at")
WHERE "schedule_id" IS NOT NULL;
