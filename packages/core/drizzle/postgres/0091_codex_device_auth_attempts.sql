-- Durable tenant/user authority for Codex device authorization in HA. Device
-- identifiers and user codes are stored only in an authenticated envelope.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE SEQUENCE "codex_device_auth_attempt_generation_seq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_user_id_unique"
	ON "users" ("tenant_id", "user_id");
--> statement-breakpoint
CREATE TABLE "codex_device_auth_attempts" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"attempt_id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"attempt_generation" bigint NOT NULL,
	"envelope_version" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"sealed_material" text,
	"poll_interval_ms" integer,
	"poll_next_at" timestamp with time zone,
	"poll_claim_id" varchar(36),
	"poll_claim_generation" bigint DEFAULT 0 NOT NULL,
	"poll_lease_expires_at" timestamp with time zone,
	"exchange_claim_id" varchar(36),
	"failure_code" text,
	"plan_type" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchange_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "codex_device_auth_attempts_tenant_user_fk"
		FOREIGN KEY ("tenant_id", "user_id") REFERENCES "public"."users"("tenant_id", "user_id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "codex_device_auth_attempts_status_check" CHECK ("status" IN (
		'starting','pending','exchanging','persisting','succeeded','unavailable','denied',
		'failed','ambiguous','expired','superseded','cancelled'
	)),
	CONSTRAINT "codex_device_auth_attempts_interval_check"
		CHECK ("poll_interval_ms" IS NULL OR "poll_interval_ms" >= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "codex_device_auth_attempts_current_user_uq"
	ON "codex_device_auth_attempts" ("tenant_id", "user_id") WHERE "is_current" = true;
--> statement-breakpoint
CREATE INDEX "codex_device_auth_attempts_tenant_user_idx"
	ON "codex_device_auth_attempts" ("tenant_id", "user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "codex_device_auth_attempts_poll_idx"
	ON "codex_device_auth_attempts" ("status", "poll_next_at", "poll_lease_expires_at");
--> statement-breakpoint
CREATE INDEX "codex_device_auth_attempts_maintenance_idx"
	ON "codex_device_auth_attempts" ("status", "expires_at", "exchange_started_at", "finished_at");
--> statement-breakpoint
ALTER TABLE "codex_device_auth_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "codex_device_auth_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_codex_device_auth_attempts" ON "codex_device_auth_attempts"
	USING (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	)
	WITH CHECK (
		COALESCE(current_setting('agor.system_scope', true), '') = ''
		AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	);
--> statement-breakpoint
-- Every replica may age due attempts and purge tombstones, but the capability
-- can see only due inputs and terminal rows produced in this transaction.
CREATE POLICY "codex_device_auth_maintenance_select" ON "codex_device_auth_attempts"
	FOR SELECT
	USING (
		current_setting('agor.system_scope', true) = 'codex_device_auth_maintenance'
		AND (
			("status" IN ('starting','pending') AND "expires_at" <= clock_timestamp())
			OR ("status" IN ('exchanging','persisting')
				AND "exchange_started_at" <= clock_timestamp() - INTERVAL '2 minutes')
			OR ("status" IN ('succeeded','unavailable','denied','failed','ambiguous','expired','superseded','cancelled')
				AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours')
			OR ("status" IN ('ambiguous','expired') AND "sealed_material" IS NULL
				AND "finished_at" >= CURRENT_TIMESTAMP)
		)
	);
--> statement-breakpoint
CREATE POLICY "codex_device_auth_maintenance_update" ON "codex_device_auth_attempts"
	FOR UPDATE
	USING (
		current_setting('agor.system_scope', true) = 'codex_device_auth_maintenance'
		AND (
			("status" IN ('starting','pending') AND "expires_at" <= clock_timestamp())
			OR ("status" IN ('exchanging','persisting')
				AND "exchange_started_at" <= clock_timestamp() - INTERVAL '2 minutes')
		)
	)
	WITH CHECK (
		current_setting('agor.system_scope', true) = 'codex_device_auth_maintenance'
		AND "status" IN ('expired','ambiguous') AND "sealed_material" IS NULL
		AND "finished_at" >= CURRENT_TIMESTAMP
	);
--> statement-breakpoint
CREATE POLICY "codex_device_auth_maintenance_delete" ON "codex_device_auth_attempts"
	FOR DELETE
	USING (
		current_setting('agor.system_scope', true) = 'codex_device_auth_maintenance'
		AND "status" IN ('succeeded','unavailable','denied','failed','ambiguous','expired','superseded','cancelled')
		AND "finished_at" <= clock_timestamp() - INTERVAL '24 hours'
	);
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
