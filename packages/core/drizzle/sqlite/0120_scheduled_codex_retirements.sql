CREATE TABLE "scheduled_codex_retirements" (
  "session_id" text PRIMARY KEY NOT NULL,
  "branch_id" text NOT NULL,
  "user_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "next_attempt_at" integer NOT NULL,
  "retired_at" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_codex_retirements_thread" ON "scheduled_codex_retirements" ("branch_id", "thread_id");
--> statement-breakpoint
CREATE INDEX "scheduled_codex_retirements_due" ON "scheduled_codex_retirements" ("retired_at", "next_attempt_at");
