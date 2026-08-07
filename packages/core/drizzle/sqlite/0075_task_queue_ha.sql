-- Standalone SQLite has no cross-tenant RLS capability, but uses the same
-- bounded per-Session recovery scan.
CREATE INDEX "tasks_queue_scan_idx"
  ON "tasks" ("session_id", "created_at")
  WHERE "status" = 'queued';
