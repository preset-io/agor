-- Restore two `sessions` indexes that schema.sqlite.ts declares but no SQLite
-- database has: they were dropped by a table rebuild and never recreated.
--
--   sessions_agentic_tool_idx    created by 0000_pretty_mac_gargan
--   sessions_scheduled_flag_idx  created by 0002_clammy_captain_flint
--
-- 0009_reconcile-missing-columns rebuilt `sessions` with the SQLite
-- create/copy/DROP TABLE/rename dance. Dropping the old table drops its
-- indexes, and 0009 recreated only six of them. Nothing since has recreated
-- these two, so every SQLite database migrated past 0009 is missing them while
-- the schema still asks for them. The later 0113 rebuild is not the cause —
-- it faithfully reproduced the set it inherited.
--
-- Postgres is unaffected: 0000_loud_loki created both, no Postgres migration
-- rebuilds `sessions`, and 0113 there is a plain ALTER TABLE ... SET NOT NULL.
-- This repair is therefore SQLite-only by design.
--
-- IF NOT EXISTS keeps this a no-op on any database that already has them.

CREATE INDEX IF NOT EXISTS `sessions_agentic_tool_idx` ON `sessions` (`agentic_tool`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_scheduled_flag_idx` ON `sessions` (`scheduled_from_branch`);
