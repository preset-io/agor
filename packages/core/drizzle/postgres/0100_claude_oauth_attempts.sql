-- Durable authority for Claude subscription OAuth sign-in attempts. The raw
-- OAuth state, the authorization code, and the resulting access and refresh
-- tokens are deliberately absent. state_hash is SHA-256 over the high-entropy
-- one-time state; the PKCE verifier is stored only inside sealed_material.
-- Unlike mcp_oauth_pending_flows there is no unauthenticated provider callback
-- — the user pastes the code back into an authenticated session — so this table
-- gets no state-hash capability policy and no agor.oauth_state_hash binding.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "claude_oauth_attempts" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"attempt_id" varchar(36) PRIMARY KEY NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"attempt_generation" bigint NOT NULL,
	"envelope_version" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sealed_material" text,
	"exchange_claim_id" varchar(36),
	"failure_code" text,
	"subscription_type" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchange_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "claude_oauth_attempts_tenant_user_fk"
		FOREIGN KEY ("tenant_id", "user_id") REFERENCES "public"."users"("tenant_id", "user_id")
		ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE SEQUENCE "claude_oauth_attempt_generation_seq";
--> statement-breakpoint
CREATE UNIQUE INDEX "claude_oauth_attempts_state_hash_unique"
	ON "claude_oauth_attempts" ("state_hash");
--> statement-breakpoint
CREATE INDEX "claude_oauth_attempts_tenant_user_idx"
	ON "claude_oauth_attempts" ("tenant_id", "user_id", "created_at");
--> statement-breakpoint
-- The durable replacement for the process-local "one in-flight attempt per
-- user" Map invariant: at most one live attempt row can exist per tenant user.
CREATE UNIQUE INDEX "claude_oauth_attempts_current_user_uq"
	ON "claude_oauth_attempts" ("tenant_id", "user_id")
	WHERE "is_current" = true;
--> statement-breakpoint
CREATE INDEX "claude_oauth_attempts_maintenance_idx"
	ON "claude_oauth_attempts" ("status", "expires_at", "exchange_started_at", "finished_at");
--> statement-breakpoint
ALTER TABLE "claude_oauth_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "claude_oauth_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_claude_oauth_attempts" ON "claude_oauth_attempts"
	USING (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
	)
	WITH CHECK (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
	);
--> statement-breakpoint
-- Every daemon may age due attempts and delete old terminal tombstones. The
-- policy exposes only rows that are already due for that exact maintenance,
-- plus expired/ambiguous rows produced at this transaction's database time.
-- PostgreSQL applies SELECT RLS to an UPDATE's new row even without RETURNING,
-- so that second, self-expiring arm is required for the maintenance transition.
CREATE POLICY "claude_oauth_maintenance_select" ON "claude_oauth_attempts"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND (
			("status" = 'pending' AND "expires_at" <= CURRENT_TIMESTAMP)
			OR ("status" IN ('exchanging', 'persisting') AND "exchange_started_at" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
			OR ("status" IN ('succeeded', 'failed', 'ambiguous', 'expired')
				AND "finished_at" <= CURRENT_TIMESTAMP - INTERVAL '24 hours')
			OR ("status" IN ('ambiguous', 'expired')
				AND "sealed_material" IS NULL
				AND "finished_at" = CURRENT_TIMESTAMP)
		)
	);
--> statement-breakpoint
CREATE POLICY "claude_oauth_maintenance_update" ON "claude_oauth_attempts"
	FOR UPDATE
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND (
			("status" = 'pending' AND "expires_at" <= CURRENT_TIMESTAMP)
			OR ("status" IN ('exchanging', 'persisting') AND "exchange_started_at" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
		)
	)
	WITH CHECK (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND "status" IN ('expired', 'ambiguous')
		AND "sealed_material" IS NULL
	);
--> statement-breakpoint
CREATE POLICY "claude_oauth_maintenance_delete" ON "claude_oauth_attempts"
	FOR DELETE
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND "status" IN ('succeeded', 'failed', 'ambiguous', 'expired')
		AND "finished_at" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
	);
