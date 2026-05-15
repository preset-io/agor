-- Heal sessions/tasks stranded in `awaiting_input` after #1177.
--
-- Mirror of sqlite/0044_heal_legacy_awaiting_input.sql. With the
-- AskUserQuestion tool disallowed at the SDK layer, any row still in
-- `awaiting_input` at upgrade has no path back to running — the answer
-- route is gone. Mark them `timed_out` so the user can re-prompt.

UPDATE "tasks"
SET "status" = 'timed_out',
    "completed_at" = COALESCE("completed_at", now())
WHERE "status" = 'awaiting_input';
--> statement-breakpoint

UPDATE "sessions"
SET "status" = 'timed_out',
    "ready_for_prompt" = TRUE
WHERE "status" = 'awaiting_input';
