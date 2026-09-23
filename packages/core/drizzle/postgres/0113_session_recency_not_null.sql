SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Fence writers while backfilling and installing the constraint. Runtime RLS
-- stays forced; migration-only policies expose only this table, in this tx.
LOCK TABLE "sessions" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE POLICY "session_recency_0113_select" ON "sessions"
  FOR SELECT USING (current_setting('agor.system_scope', true) = 'session_recency_0113');
--> statement-breakpoint
CREATE POLICY "session_recency_0113_update" ON "sessions"
  FOR UPDATE USING (current_setting('agor.system_scope', true) = 'session_recency_0113')
  WITH CHECK (current_setting('agor.system_scope', true) = 'session_recency_0113');
--> statement-breakpoint
SELECT set_config('agor.system_scope', 'session_recency_0113', true);
--> statement-breakpoint
UPDATE "sessions" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
--> statement-breakpoint
DROP POLICY "session_recency_0113_select" ON "sessions";
--> statement-breakpoint
DROP POLICY "session_recency_0113_update" ON "sessions";
--> statement-breakpoint
SELECT set_config('agor.system_scope', '', true);
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "updated_at" SET NOT NULL;
