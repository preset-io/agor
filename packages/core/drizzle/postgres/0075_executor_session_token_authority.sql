-- Shared executor-session JWT authority. The raw bearer is never persisted:
-- token_fingerprint is SHA-256 over the signed high-entropy JWT and is useful
-- only as an exact lookup after signature verification.
CREATE TABLE "executor_session_token_authorities" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"token_fingerprint" varchar(64) PRIMARY KEY NOT NULL,
	"token_type" text NOT NULL,
	"purpose" text NOT NULL,
	"session_id" text NOT NULL,
	"task_id" text,
	"branch_id" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "executor_session_token_authorities_tenant_session_idx"
	ON "executor_session_token_authorities" ("tenant_id", "session_id");
--> statement-breakpoint
CREATE INDEX "executor_session_token_authorities_expires_idx"
	ON "executor_session_token_authorities" ("expires_at");
--> statement-breakpoint
CREATE INDEX "executor_session_token_authorities_revoked_idx"
	ON "executor_session_token_authorities" ("revoked_at")
	WHERE "revoked_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "executor_session_token_authorities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "executor_session_token_authorities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_executor_session_token_authorities" ON "executor_session_token_authorities"
	USING (
		"tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	)
	WITH CHECK (
		"tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	);
--> statement-breakpoint
-- Every daemon may discover retained rows for the cleanup repository, which
-- projects only bounded tenant routing IDs. Deletion then re-enters each
-- tenant's ordinary RLS scope.
CREATE POLICY "executor_session_token_maintenance"
	ON "executor_session_token_authorities"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'executor_token_maintenance'
		AND (
			"expires_at" < CURRENT_TIMESTAMP - INTERVAL '24 hours'
			OR "revoked_at" < CURRENT_TIMESTAMP - INTERVAL '24 hours'
		)
	);
