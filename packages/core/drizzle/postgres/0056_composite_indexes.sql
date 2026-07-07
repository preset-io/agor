-- Composite indexes to reduce idle-in-transaction window (zombie transaction fix).
--
-- session_relationships: tenant+source and tenant+target so the OR predicate
-- in dispatchCompletionCallbacks uses BitmapOr rather than a full tenant scan.
--
-- sessions: (status, ready_for_prompt) for queue-processing queries that
-- filter on both columns.
--
-- tasks: (session_id, created_at) for "latest task for session" lookups used
-- in completion and heartbeat paths.

CREATE INDEX IF NOT EXISTS "session_relationships_tenant_source_idx" ON "session_relationships" ("tenant_id","source_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_relationships_tenant_target_idx" ON "session_relationships" ("tenant_id","target_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_status_ready_idx" ON "sessions" ("status","ready_for_prompt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_session_created_idx" ON "tasks" ("session_id","created_at");
