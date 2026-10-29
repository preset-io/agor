SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "trigger_token_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "trigger_token_created_at" bigint;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_triggered_at" bigint;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "trigger_pending_at" bigint;
--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_trigger_token_hash_unique" ON "schedules" ("trigger_token_hash");
--> statement-breakpoint
CREATE INDEX "schedules_trigger_pending_idx" ON "schedules" ("trigger_pending_at")
  WHERE "trigger_pending_at" IS NOT NULL;
--> statement-breakpoint
-- The unauthenticated trigger route knows only the high-entropy bearer. This
-- capability may discover the owning tenant of one token hash; the daemon then
-- leaves system scope and reloads the schedule under that tenant's RLS policy.
CREATE POLICY "schedule_trigger_discovery" ON "schedules"
  FOR SELECT
  USING (
    "trigger_token_hash" IS NOT NULL
    AND current_setting('agor.system_scope', true) = 'schedule_trigger_discovery'
  );
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
