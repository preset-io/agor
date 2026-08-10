-- Durable authority for browser-based MCP OAuth attempts. The raw OAuth
-- state, authorization code, access token, and refresh token are deliberately
-- absent. state_hash is SHA-256 over the high-entropy one-time state; PKCE,
-- client credentials, and endpoints are stored only in sealed_material.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Protocol-breaking cutover: pre-0077 grant rows contain plaintext secrets and
-- have neither configuration nor refresh fences. They cannot safely coexist
-- with the HA authority, so operators must drain daemons and users reauthorize.
DELETE FROM "user_mcp_oauth_tokens";
--> statement-breakpoint
ALTER TABLE "user_mcp_oauth_tokens"
	ADD COLUMN "grant_generation" bigint DEFAULT 0 NOT NULL,
	ADD COLUMN "grant_binding_version" integer,
	ADD COLUMN "grant_binding_fingerprint" varchar(64),
	ADD COLUMN "oauth_metadata_uri" text,
	ADD COLUMN "oauth_resource_uri" text,
	ADD COLUMN "oauth_issuer" text,
	ADD COLUMN "oauth_authorization_endpoint" text,
	ADD COLUMN "oauth_token_endpoint" text,
	ADD COLUMN "oauth_redirect_uri" text,
	ADD COLUMN "refresh_status" text DEFAULT 'idle' NOT NULL,
	ADD COLUMN "refresh_generation" bigint DEFAULT 0 NOT NULL,
	ADD COLUMN "refresh_claim_id" varchar(36),
	ADD COLUMN "refresh_claimed_at" timestamp with time zone;
--> statement-breakpoint
CREATE SEQUENCE "mcp_oauth_grant_generation_seq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_user_id_unique"
	ON "users" ("tenant_id", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_tenant_server_id_unique"
	ON "mcp_servers" ("tenant_id", "mcp_server_id");
--> statement-breakpoint
-- The legacy grant table acquired tenant_id after its original single-column
-- foreign keys. Keep those cascade constraints, and add composite tenant
-- binding so an application bug cannot write a tenant-A row referencing a
-- tenant-B user/server while still satisfying RLS on tenant_id alone.
ALTER TABLE "user_mcp_oauth_tokens"
	ADD CONSTRAINT "user_mcp_oauth_tokens_tenant_user_fk"
	FOREIGN KEY ("tenant_id", "user_id") REFERENCES "public"."users"("tenant_id", "user_id")
	ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE,
	ADD CONSTRAINT "user_mcp_oauth_tokens_tenant_server_fk"
	FOREIGN KEY ("tenant_id", "mcp_server_id") REFERENCES "public"."mcp_servers"("tenant_id", "mcp_server_id")
	ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
CREATE TABLE "mcp_oauth_pending_flows" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"attempt_id" varchar(36) PRIMARY KEY NOT NULL,
	"state_hash" varchar(64) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"mcp_server_id" varchar(36) NOT NULL,
	"oauth_mode" text NOT NULL,
	"subject_user_id" varchar(36),
	"grant_generation" bigint NOT NULL,
	"config_fingerprint_version" integer NOT NULL,
	"config_fingerprint" varchar(64) NOT NULL,
	"envelope_version" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sealed_material" text,
	"exchange_claim_id" varchar(36),
	"failure_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchange_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "mcp_oauth_pending_flows_tenant_user_fk"
		FOREIGN KEY ("tenant_id", "user_id") REFERENCES "public"."users"("tenant_id", "user_id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "mcp_oauth_pending_flows_tenant_server_fk"
		FOREIGN KEY ("tenant_id", "mcp_server_id") REFERENCES "public"."mcp_servers"("tenant_id", "mcp_server_id")
		ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_pending_flows_state_hash_unique"
	ON "mcp_oauth_pending_flows" ("state_hash");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_pending_flows_tenant_user_idx"
	ON "mcp_oauth_pending_flows" ("tenant_id", "user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_pending_flows_tenant_server_idx"
	ON "mcp_oauth_pending_flows" ("tenant_id", "mcp_server_id");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_pending_flows_grant_idx"
	ON "mcp_oauth_pending_flows" ("tenant_id", "mcp_server_id", "oauth_mode", "subject_user_id", "grant_generation");
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_pending_flows_current_user_grant_uq"
	ON "mcp_oauth_pending_flows" ("tenant_id", "mcp_server_id", "oauth_mode", "subject_user_id")
	WHERE "is_current" = true AND "subject_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_pending_flows_current_shared_grant_uq"
	ON "mcp_oauth_pending_flows" ("tenant_id", "mcp_server_id", "oauth_mode")
	WHERE "is_current" = true AND "subject_user_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "mcp_oauth_pending_flows_maintenance_idx"
	ON "mcp_oauth_pending_flows" ("status", "expires_at", "exchange_started_at", "finished_at");
--> statement-breakpoint
ALTER TABLE "mcp_oauth_pending_flows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_pending_flows" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_mcp_oauth_pending_flows" ON "mcp_oauth_pending_flows"
	USING (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	)
	WITH CHECK (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	);
--> statement-breakpoint
-- An unauthenticated provider redirect carries only the one-time state. The
-- callback capability is available solely inside a transaction-local system
-- scope, and application SQL always supplies one exact state_hash predicate.
CREATE POLICY "mcp_oauth_callback_select" ON "mcp_oauth_pending_flows"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'mcp_oauth_callback'
		AND "state_hash" = current_setting('agor.oauth_state_hash', true)
	);
--> statement-breakpoint
CREATE POLICY "mcp_oauth_callback_update" ON "mcp_oauth_pending_flows"
	FOR UPDATE
	USING (
		current_setting('agor.system_scope', true) = 'mcp_oauth_callback'
		AND "state_hash" = current_setting('agor.oauth_state_hash', true)
		AND "status" = 'pending'
	)
	WITH CHECK (
		current_setting('agor.system_scope', true) = 'mcp_oauth_callback'
		AND "state_hash" = current_setting('agor.oauth_state_hash', true)
		AND "status" IN ('exchanging', 'failed', 'expired')
	);
--> statement-breakpoint
-- Every daemon may age due attempts and delete old terminal tombstones. The
-- policy exposes only rows that are already due for that exact maintenance,
-- plus expired/ambiguous rows produced at this transaction's database time.
-- PostgreSQL applies SELECT RLS to an UPDATE's new row even without RETURNING,
-- so that second, self-expiring arm is required for the maintenance transition.
CREATE POLICY "mcp_oauth_maintenance_select" ON "mcp_oauth_pending_flows"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'mcp_oauth_maintenance'
		AND (
			("status" = 'pending' AND "expires_at" <= CURRENT_TIMESTAMP)
			OR ("status" = 'exchanging' AND "exchange_started_at" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
			OR ("status" IN ('succeeded', 'failed', 'ambiguous', 'expired')
				AND "finished_at" <= CURRENT_TIMESTAMP - INTERVAL '24 hours')
			OR ("status" IN ('ambiguous', 'expired')
				AND "sealed_material" IS NULL
				AND "finished_at" = CURRENT_TIMESTAMP)
		)
	);
--> statement-breakpoint
CREATE POLICY "mcp_oauth_maintenance_update" ON "mcp_oauth_pending_flows"
	FOR UPDATE
	USING (
		current_setting('agor.system_scope', true) = 'mcp_oauth_maintenance'
		AND (
			("status" = 'pending' AND "expires_at" <= CURRENT_TIMESTAMP)
			OR ("status" = 'exchanging' AND "exchange_started_at" <= CURRENT_TIMESTAMP - INTERVAL '2 minutes')
		)
	)
	WITH CHECK (
		current_setting('agor.system_scope', true) = 'mcp_oauth_maintenance'
		AND "status" IN ('expired', 'ambiguous')
		AND "sealed_material" IS NULL
	);
--> statement-breakpoint
CREATE POLICY "mcp_oauth_maintenance_delete" ON "mcp_oauth_pending_flows"
	FOR DELETE
	USING (
		current_setting('agor.system_scope', true) = 'mcp_oauth_maintenance'
		AND "status" IN ('succeeded', 'failed', 'ambiguous', 'expired')
		AND "finished_at" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
	);
