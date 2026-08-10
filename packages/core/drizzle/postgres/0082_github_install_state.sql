-- HA-safe GitHub App setup state. Only SHA-256 of the 256-bit random browser
-- bearer is persisted; the raw state remains outside PostgreSQL and Redis.
CREATE TABLE "github_install_states" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"state_hash" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"intent" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "github_install_states_expires_idx"
	ON "github_install_states" ("expires_at");
--> statement-breakpoint
ALTER TABLE "github_install_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "github_install_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_github_install_states" ON "github_install_states"
	USING (
		"tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	)
	WITH CHECK (
		"tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	);
--> statement-breakpoint
-- The unauthenticated GitHub redirect knows only the high-entropy state. This
-- narrowly named capability may discover the owning tenant for one hash+intent;
-- consumption then leaves system scope and performs an atomic DELETE under the
-- discovered tenant's ordinary RLS policy.
CREATE POLICY "github_install_state_callback_discovery"
	ON "github_install_states"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'github_install_state_callback'
	);
--> statement-breakpoint
-- All daemons may discover only expired tenant routing IDs. Actual deletion is
-- tenant-scoped, idempotent, and never returns state hashes to the caller.
CREATE POLICY "github_install_state_maintenance"
	ON "github_install_states"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'github_install_state_maintenance'
		AND "expires_at" <= CURRENT_TIMESTAMP
	);
