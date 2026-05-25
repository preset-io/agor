-- Partial unique index on (schedule_id, scheduled_run_at) for non-null
-- schedule_id rows. Closes a check-then-create race in the scheduler:
-- within a single Node process, the spawn path has async-yield points
-- between findScheduleRun → hasActiveSessionInBranch → sessionsService
-- .create where two concurrent paths (e.g. cron tick + manual run-now,
-- or back-to-back ticks on the same scheduledRunAt) could both observe
-- "no existing session" and both insert.
--
-- The unique constraint makes that race resolve at the DB layer — the
-- second insert hits SQLITE_CONSTRAINT, the repo bubbles it as a normal
-- create error, the scheduler treats it as a dedup hit on the next
-- tick.
--
-- Partial (`WHERE schedule_id IS NOT NULL`) because the column is
-- nullable: ad-hoc sessions (no schedule) all have schedule_id NULL
-- and would otherwise clash with each other.
--
-- Defensive cleanup: drop any duplicate rows before the unique index is
-- created, keeping the newest (highest session_id since UUIDv7 sorts
-- monotonically). A buggy daemon couldn't have created duplicates on a
-- shipped install — the original `sessions_schedule_id_idx` was added
-- in 0046 and dedup has always been in spawnScheduledSession — but the
-- cleanup is cheap insurance against a dev DB carrying weird state
-- from earlier WIP commits on this branch.

DELETE FROM `sessions`
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
      FROM `sessions`
      WHERE schedule_id IS NOT NULL
    )
    WHERE rn = 1
  );--> statement-breakpoint

DROP INDEX IF EXISTS `sessions_schedule_id_idx`;--> statement-breakpoint

CREATE UNIQUE INDEX `sessions_schedule_run_unique` ON `sessions` (`schedule_id`, `scheduled_run_at`)
WHERE `schedule_id` IS NOT NULL;
