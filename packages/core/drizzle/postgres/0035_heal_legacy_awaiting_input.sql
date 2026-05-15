-- Heal sessions/tasks stranded in `awaiting_input` after #1177.
--
-- Mirror of sqlite/0044_heal_legacy_awaiting_input.sql. With the
-- AskUserQuestion tool disallowed at the SDK layer, any row still in
-- `awaiting_input` at upgrade has no path back to running — the answer
-- route is gone. Mark them `timed_out` so the user can re-prompt, and
-- stamp `data.report` so the upgraded user can see *why*.

UPDATE "tasks"
SET "status" = 'timed_out',
    "completed_at" = COALESCE("completed_at", now()),
    "data" = jsonb_set(
      "data",
      '{report}',
      '"Legacy AskUserQuestion timed out — the interactive question tool was removed in #1177 because it hung the executor in gateway channels. Re-prompt the agent to continue."'::jsonb,
      true
    )
WHERE "status" = 'awaiting_input';
--> statement-breakpoint

UPDATE "sessions"
SET "status" = 'timed_out',
    "ready_for_prompt" = TRUE
WHERE "status" = 'awaiting_input';
