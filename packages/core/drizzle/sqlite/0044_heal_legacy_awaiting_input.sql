-- Heal sessions/tasks stranded in `awaiting_input` after #1177.
--
-- Pre-#1177, the AskUserQuestion tool blocked the executor in a `canUseTool`
-- callback waiting for a UI answer. Those rows would sit in the
-- `awaiting_input` state until the input timed out (30 min). With the tool
-- disallowed at the SDK layer the answer route is also gone, so any row still
-- in that state at upgrade has no path back to running. Mark them
-- `timed_out` so the user can re-prompt and the worktree's "active session"
-- counter doesn't pin on them forever.
--
-- Mirrors postgres/0035_heal_legacy_awaiting_input.sql.

UPDATE `tasks`
SET `status` = 'timed_out',
    `completed_at` = COALESCE(`completed_at`, unixepoch() * 1000)
WHERE `status` = 'awaiting_input';
--> statement-breakpoint

UPDATE `sessions`
SET `status` = 'timed_out',
    `ready_for_prompt` = 1
WHERE `status` = 'awaiting_input';
