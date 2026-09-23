CREATE TABLE "opencode_checkpoint_attempts" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "attempt_id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "task_id" text NOT NULL,
  "store_id" text NOT NULL,
  "attempt_no" integer NOT NULL CHECK ("attempt_no" > 0),
  "holder_instance_id" text NOT NULL,
  "binding" text NOT NULL,
  "input_store_id" text,
  "input_task_id" text,
  "input_read_closed_at" integer,
  "write_state" text NOT NULL CHECK ("write_state" IN ('open', 'sealed', 'abandoned')),
  "sealed_manifest" text,
  "retired_at" integer,
  "delete_observed_at" integer,
  "delete_retry_at" integer,
  "delete_failure_count" integer DEFAULT 0 NOT NULL CHECK ("delete_failure_count" >= 0),
  "delete_last_error" text,
  "holder_closed_observed_at" integer,
  "holder_observation_retry_at" integer,
  "holder_observation_failure_count" integer DEFAULT 0 NOT NULL CHECK ("holder_observation_failure_count" >= 0),
  "holder_observation_last_error" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  CONSTRAINT "opencode_checkpoint_attempts_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("user_id") ON DELETE RESTRICT,
  CONSTRAINT "opencode_checkpoint_attempts_session_fk" FOREIGN KEY ("session_id") REFERENCES "sessions" ("session_id") ON DELETE RESTRICT,
  CONSTRAINT "opencode_checkpoint_attempts_task_fk" FOREIGN KEY ("task_id") REFERENCES "tasks" ("task_id") ON DELETE RESTRICT,
  CONSTRAINT "opencode_checkpoint_attempts_input_fk" FOREIGN KEY ("input_task_id") REFERENCES "tasks" ("task_id") ON DELETE RESTRICT,
  CONSTRAINT "opencode_checkpoint_attempts_input_pair_check" CHECK (("input_store_id" IS NULL) = ("input_task_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_task_unique" ON "opencode_checkpoint_attempts" ("tenant_id", "task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_store_task_unique" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "store_id", "task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_session_no_unique" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "attempt_no");
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_session_order_idx" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "attempt_no");
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_live_input_idx" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "input_store_id", "input_task_id") WHERE "input_task_id" IS NOT NULL AND "input_read_closed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_retirement_retry_idx" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "retired_at", "delete_retry_at");
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_holder_observation_idx" ON "opencode_checkpoint_attempts" ("tenant_id", "session_id", "holder_observation_retry_at", "attempt_no");
