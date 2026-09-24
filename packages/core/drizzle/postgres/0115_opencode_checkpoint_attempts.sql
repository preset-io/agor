SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_tenant_session_key" ON "sessions" ("tenant_id", "session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_tenant_task_key" ON "tasks" ("tenant_id", "task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_tenant_session_task_key" ON "tasks" ("tenant_id", "session_id", "task_id");
--> statement-breakpoint
CREATE TABLE "opencode_checkpoint_attempts" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "attempt_id" varchar(36) PRIMARY KEY NOT NULL,
  "owner_user_id" varchar(36) NOT NULL,
  "session_id" varchar(36) NOT NULL,
  "task_id" varchar(36) NOT NULL,
  "store_id" varchar(36) NOT NULL,
  "attempt_no" integer NOT NULL CHECK ("attempt_no" > 0),
  "holder_instance_id" varchar(36) NOT NULL,
  "binding" jsonb NOT NULL,
  "input_store_id" varchar(36),
  "input_task_id" varchar(36),
  "input_read_closed_at" timestamp with time zone,
  "write_state" text NOT NULL CHECK ("write_state" IN ('open', 'sealed', 'abandoned')),
  "sealed_manifest" jsonb,
  "retired_at" timestamp with time zone,
  "delete_observed_at" timestamp with time zone,
  "delete_retry_at" timestamp with time zone,
  "delete_failure_count" integer DEFAULT 0 NOT NULL CHECK ("delete_failure_count" >= 0),
  "delete_last_error" text,
  "holder_closed_observed_at" timestamp with time zone,
  "holder_observation_retry_at" timestamp with time zone,
  "holder_observation_failure_count" integer DEFAULT 0 NOT NULL CHECK ("holder_observation_failure_count" >= 0),
  "holder_observation_last_error" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "opencode_checkpoint_attempts_tenant_owner_fk"
    FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "users" ("tenant_id", "user_id") ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "opencode_checkpoint_attempts_tenant_session_fk"
    FOREIGN KEY ("tenant_id", "session_id") REFERENCES "sessions" ("tenant_id", "session_id") ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "opencode_checkpoint_attempts_tenant_task_fk"
    FOREIGN KEY ("tenant_id", "task_id") REFERENCES "tasks" ("tenant_id", "task_id") ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "opencode_checkpoint_attempts_input_fk"
    FOREIGN KEY ("tenant_id", "session_id", "input_task_id")
    REFERENCES "tasks" ("tenant_id", "session_id", "task_id") ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "opencode_checkpoint_attempts_input_pair_check"
    CHECK (("input_store_id" IS NULL) = ("input_task_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_task_unique" ON "opencode_checkpoint_attempts" ("tenant_id", "task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_store_task_unique" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "store_id", "task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_session_no_unique" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "attempt_no");
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_tenant_idx" ON "opencode_checkpoint_attempts" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_live_input_idx" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "input_store_id", "input_task_id") WHERE "input_task_id" IS NOT NULL AND "input_read_closed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_retirement_retry_idx" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "retired_at", "delete_retry_at");
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_holder_observation_idx" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "holder_observation_retry_at", "attempt_no");
--> statement-breakpoint
ALTER TABLE "opencode_checkpoint_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "opencode_checkpoint_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_opencode_checkpoint_attempts" ON "opencode_checkpoint_attempts"
USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
