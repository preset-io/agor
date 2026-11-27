CREATE TABLE "scheduled_codex_retirements" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "session_id" varchar(36) PRIMARY KEY NOT NULL,
  "branch_id" varchar(36) NOT NULL,
  "user_id" varchar(36) NOT NULL,
  "thread_id" varchar(36) NOT NULL,
  "next_attempt_at" timestamp with time zone NOT NULL,
  "retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_codex_retirements_thread" ON "scheduled_codex_retirements" ("tenant_id", "branch_id", "thread_id");
--> statement-breakpoint
CREATE INDEX "scheduled_codex_retirements_due" ON "scheduled_codex_retirements" ("tenant_id", "retired_at", "next_attempt_at");
--> statement-breakpoint
ALTER TABLE "scheduled_codex_retirements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "scheduled_codex_retirements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_scheduled_codex_retirements" ON "scheduled_codex_retirements"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
--> statement-breakpoint
CREATE POLICY "scheduler_codex_retirement_discovery" ON "scheduled_codex_retirements" FOR SELECT
USING ("retired_at" IS NULL AND current_setting('agor.system_scope', true) = 'scheduler_discovery');
