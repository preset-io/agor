-- Reconcile the timestamp-only migration collision shipped on the old PR head
-- b0585d76. Its incompatible DCR migration used the same watermark as final
-- 0101, so those databases skip both final 0100 and 0101. This later offline
-- watermark repairs the physical schema and makes the final database visibly
-- newer to every old binary. Legacy DCR credentials are deliberately discarded:
-- their generation-based authority cannot be safely translated into final UUID
-- CAS authority, and the next reconnect performs a fresh registration.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DO $$
DECLARE
  has_legacy_generation boolean;
  has_final_shape boolean;
BEGIN
  IF to_regclass('public.mcp_oauth_client_registrations') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mcp_oauth_client_registrations'
        AND column_name = 'registration_generation'
    ) INTO has_legacy_generation;

    SELECT COUNT(*) = 8
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'mcp_oauth_client_registrations'
      AND column_name IN (
        'tenant_id', 'registration_id', 'mcp_server_id', 'binding_fingerprint',
        'server_config_version', 'claim_generation', 'status', 'sealed_material'
      )
    INTO has_final_shape;

    IF has_legacy_generation THEN
      DROP TABLE public.mcp_oauth_client_registrations;
    ELSIF NOT has_final_shape THEN
      RAISE EXCEPTION 'unrecognized mcp_oauth_client_registrations schema; refusing automatic reconciliation';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
-- The legacy sequence was not owned by its generation column, so remove it
-- explicitly even after the table is dropped.
DROP SEQUENCE IF EXISTS "mcp_oauth_client_registration_generation_seq";
--> statement-breakpoint
DO $$
DECLARE
  has_final_shape boolean;
BEGIN
  IF to_regclass('public.claude_oauth_attempts') IS NOT NULL THEN
    SELECT COUNT(*) = 8
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'claude_oauth_attempts'
      AND column_name IN (
        'tenant_id', 'attempt_id', 'state_hash', 'user_id',
        'attempt_generation', 'status', 'sealed_material', 'exchange_claim_id'
      )
    INTO has_final_shape;
    IF NOT has_final_shape THEN
      RAISE EXCEPTION 'unrecognized claude_oauth_attempts schema; refusing automatic reconciliation';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
-- Durable authority for Claude subscription OAuth sign-in attempts. The raw
-- OAuth state, the authorization code, and the resulting access and refresh
-- tokens are deliberately absent. state_hash is SHA-256 over the high-entropy
-- one-time state; the PKCE verifier is stored only inside sealed_material.
-- Unlike mcp_oauth_pending_flows there is no unauthenticated provider callback
-- — the user pastes the code back into an authenticated session — so this table
-- gets no state-hash capability policy and no agor.oauth_state_hash binding.
CREATE TABLE IF NOT EXISTS "claude_oauth_attempts" (
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
CREATE SEQUENCE IF NOT EXISTS "claude_oauth_attempt_generation_seq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claude_oauth_attempts_state_hash_unique"
	ON "claude_oauth_attempts" ("state_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claude_oauth_attempts_tenant_user_idx"
	ON "claude_oauth_attempts" ("tenant_id", "user_id", "created_at");
--> statement-breakpoint
-- The durable replacement for the process-local "one in-flight attempt per
-- user" Map invariant: at most one live attempt row can exist per tenant user.
CREATE UNIQUE INDEX IF NOT EXISTS "claude_oauth_attempts_current_user_uq"
	ON "claude_oauth_attempts" ("tenant_id", "user_id")
	WHERE "is_current" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claude_oauth_attempts_maintenance_idx"
	ON "claude_oauth_attempts" ("status", "expires_at", "exchange_started_at", "finished_at");
--> statement-breakpoint
ALTER TABLE "claude_oauth_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "claude_oauth_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_claude_oauth_attempts" ON "claude_oauth_attempts";
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
DROP POLICY IF EXISTS "claude_oauth_maintenance_select" ON "claude_oauth_attempts";
--> statement-breakpoint
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
DROP POLICY IF EXISTS "claude_oauth_maintenance_update" ON "claude_oauth_attempts";
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
DROP POLICY IF EXISTS "claude_oauth_maintenance_delete" ON "claude_oauth_attempts";
--> statement-breakpoint
CREATE POLICY "claude_oauth_maintenance_delete" ON "claude_oauth_attempts"
	FOR DELETE
	USING (
		current_setting('agor.system_scope', true) = 'claude_oauth_maintenance'
		AND "status" IN ('succeeded', 'failed', 'ambiguous', 'expired')
		AND "finished_at" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
	);
--> statement-breakpoint
-- Fleet-wide, tenant-bound Dynamic Client Registration authority.
CREATE TABLE IF NOT EXISTS "mcp_oauth_client_registrations" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "registration_id" varchar(36) PRIMARY KEY NOT NULL,
  "mcp_server_id" varchar(36) NOT NULL,
  "binding_version" integer NOT NULL,
  "binding_fingerprint" varchar(64) NOT NULL,
  "server_config_version" integer NOT NULL,
  "envelope_version" integer NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "status" text DEFAULT 'registering' NOT NULL,
  "sealed_material" text,
  "claim_id" varchar(36),
  "claim_generation" bigint DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "dispatched_at" timestamp with time zone,
  "client_secret_expires_at" timestamp with time zone,
  "failure_code" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "mcp_oauth_client_registrations_tenant_server_fk"
    FOREIGN KEY ("tenant_id", "mcp_server_id")
    REFERENCES "public"."mcp_servers"("tenant_id", "mcp_server_id")
    ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT "mcp_oauth_client_registrations_status_check" CHECK ("status" IN (
    'registering','registered','failed','ambiguous','superseded','expired'
  )),
  CONSTRAINT "mcp_oauth_client_registrations_versions_check" CHECK (
    "binding_version" = 1 AND "server_config_version" > 0
    AND "envelope_version" > 0
    AND "claim_generation" >= 0
  ),
  CONSTRAINT "mcp_oauth_client_registrations_lifecycle_check" CHECK (
    ("status" = 'registering' AND "is_current" = true
      AND "sealed_material" IS NULL AND "claim_id" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL AND "finished_at" IS NULL)
    OR
    ("status" = 'registered' AND "is_current" = true
      AND "sealed_material" IS NOT NULL AND "claim_id" IS NULL
      AND "lease_expires_at" IS NULL AND "dispatched_at" IS NOT NULL
      AND "finished_at" IS NULL)
    OR
    ("status" IN ('failed','ambiguous','superseded','expired')
      AND "is_current" = false AND "sealed_material" IS NULL
      AND "claim_id" IS NULL AND "lease_expires_at" IS NULL
      AND "finished_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_current_server_uq"
  ON "mcp_oauth_client_registrations" ("tenant_id", "mcp_server_id")
  WHERE "is_current" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_tenant_server_idx"
  ON "mcp_oauth_client_registrations"
  ("tenant_id", "mcp_server_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_binding_idx"
  ON "mcp_oauth_client_registrations"
  ("tenant_id", "mcp_server_id", "binding_fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_registering_maintenance_idx"
  ON "mcp_oauth_client_registrations" ("lease_expires_at")
  WHERE "status" = 'registering' AND "is_current" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_registered_maintenance_idx"
  ON "mcp_oauth_client_registrations" ("client_secret_expires_at")
  WHERE "status" = 'registered' AND "is_current" = true
    AND "client_secret_expires_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_client_registrations_terminal_maintenance_idx"
  ON "mcp_oauth_client_registrations" ("finished_at")
  WHERE "status" IN ('failed','ambiguous','superseded','expired');
--> statement-breakpoint
ALTER TABLE "mcp_oauth_client_registrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_client_registrations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_mcp_oauth_client_registrations" ON "mcp_oauth_client_registrations";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_mcp_oauth_client_registrations" ON "mcp_oauth_client_registrations"
  USING (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
  )
  WITH CHECK (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_oauth_client_registration_maintenance_select" ON "mcp_oauth_client_registrations";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_registration_maintenance_select"
  ON "mcp_oauth_client_registrations"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND (
      ("status" = 'registering' AND "lease_expires_at" <= clock_timestamp())
      OR ("status" = 'registered' AND "client_secret_expires_at" IS NOT NULL
        AND "client_secret_expires_at" <= clock_timestamp())
      OR ("status" IN ('failed','ambiguous','superseded','expired')
        AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours')
      OR ("status" IN ('failed','ambiguous','expired')
        AND "sealed_material" IS NULL AND "finished_at" >= CURRENT_TIMESTAMP)
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_oauth_client_registration_maintenance_update" ON "mcp_oauth_client_registrations";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_registration_maintenance_update"
  ON "mcp_oauth_client_registrations"
  FOR UPDATE
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND (
      ("status" = 'registering' AND "lease_expires_at" <= clock_timestamp())
      OR ("status" = 'registered' AND "client_secret_expires_at" IS NOT NULL
        AND "client_secret_expires_at" <= clock_timestamp())
    )
  )
  WITH CHECK (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND "status" IN ('failed','ambiguous','expired')
    AND "is_current" = false AND "sealed_material" IS NULL
    AND "finished_at" >= CURRENT_TIMESTAMP
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_oauth_client_registration_maintenance_delete" ON "mcp_oauth_client_registrations";
--> statement-breakpoint
CREATE POLICY "mcp_oauth_client_registration_maintenance_delete"
  ON "mcp_oauth_client_registrations"
  FOR DELETE
  USING (
    current_setting('agor.system_scope', true) =
      'mcp_oauth_client_registration_maintenance'
    AND "status" IN ('failed','ambiguous','superseded','expired')
    AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours'
  );
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
