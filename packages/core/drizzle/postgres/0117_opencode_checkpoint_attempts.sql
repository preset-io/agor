CREATE TABLE "opencode_checkpoint_attempts" (
 "tenant_id" text DEFAULT 'default' NOT NULL,
 "attempt_id" varchar(36) PRIMARY KEY NOT NULL,
 "session_id" varchar(36) NOT NULL,
 "task_id" varchar(36) NOT NULL,
 "owner_user_id" varchar(36) NOT NULL,
 "holder_instance_id" varchar(36) NOT NULL,
 "input_task_id" varchar(36),
 "state" text NOT NULL,
 "manifest" jsonb,
 "created_at" timestamp with time zone NOT NULL,
 "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_tenant_idx" ON "opencode_checkpoint_attempts" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_task_unique" ON "opencode_checkpoint_attempts" ("tenant_id", "task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_accepted_unique" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id") WHERE "state" = 'accepted';
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_owner_idx" ON "opencode_checkpoint_attempts" ("tenant_id", "owner_user_id");
--> statement-breakpoint
ALTER TABLE "opencode_checkpoint_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "opencode_checkpoint_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_opencode_checkpoint_attempts" ON "opencode_checkpoint_attempts"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
