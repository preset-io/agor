-- Composite index to reduce idle-in-transaction window (zombie transaction fix).
--
-- sessions: (status, ready_for_prompt) for queue-processing queries that
-- filter on both columns.
--
-- Note: session_relationships and tasks indexes are postgres-only; SQLite
-- has no tenant_id on session_relationships and the existing source/target
-- indexes are sufficient.

CREATE INDEX IF NOT EXISTS `sessions_status_ready_idx` ON `sessions` (`status`,`ready_for_prompt`);
