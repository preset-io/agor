CREATE TABLE "opencode_checkpoint_attempts" (
 "attempt_id" text PRIMARY KEY NOT NULL,
 "session_id" text NOT NULL,
 "task_id" text NOT NULL,
 "owner_user_id" text NOT NULL,
 "holder_instance_id" text NOT NULL,
 "input_task_id" text,
 "state" text NOT NULL,
 "manifest" text,
 "created_at" integer NOT NULL,
 "updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_task_unique" ON "opencode_checkpoint_attempts" ("task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "opencode_checkpoint_attempts_accepted_unique" ON "opencode_checkpoint_attempts" ("session_id") WHERE "state" = 'accepted';
--> statement-breakpoint
CREATE INDEX "opencode_checkpoint_attempts_owner_idx" ON "opencode_checkpoint_attempts" ("owner_user_id");
