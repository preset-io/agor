-- Retire database-backed SDK session snapshots.
--
-- The compressed transcript payloads are intentionally discarded. There is no
-- replacement session-state backfill in this migration.
DROP TABLE `serialized_sessions`;--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `session_md5`;
