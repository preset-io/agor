SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "trigger_token_hash" varchar(64);
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
-- The unauthenticated trigger route knows only the high-entropy bearer. Under
-- this capability the database exposes exactly the one row whose hash the
-- caller bound for the transaction (agor.schedule_trigger_token_hash), so an
-- unfiltered or wrong-hash read returns nothing. The daemon reads only its
-- routing metadata, then reloads the schedule under that tenant's policy.
CREATE POLICY "schedule_trigger_discovery" ON "schedules"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) = 'schedule_trigger_discovery'
    AND "trigger_token_hash" = current_setting('agor.schedule_trigger_token_hash', true)
  );
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
