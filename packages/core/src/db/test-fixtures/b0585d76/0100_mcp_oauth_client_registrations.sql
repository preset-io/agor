-- Fleet-wide, tenant-bound Dynamic Client Registration authority.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE SEQUENCE "mcp_oauth_client_registration_generation_seq";
--> statement-breakpoint
CREATE TABLE "mcp_oauth_client_registrations" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "registration_id" varchar(36) PRIMARY KEY NOT NULL,
  "mcp_server_id" varchar(36) NOT NULL,
  "registration_generation" bigint NOT NULL,
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
    "registration_generation" > 0 AND "binding_version" = 1
    AND "server_config_version" > 0 AND "envelope_version" > 0
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
CREATE UNIQUE INDEX "mcp_oauth_client_registrations_current_server_uq"
  ON "mcp_oauth_client_registrations" ("tenant_id", "mcp_server_id")
  WHERE "is_current" = true;
--> statement-breakpoint
CREATE INDEX "mcp_oauth_client_registrations_tenant_server_idx"
  ON "mcp_oauth_client_registrations"
  ("tenant_id", "mcp_server_id", "registration_generation");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_client_registrations_binding_idx"
  ON "mcp_oauth_client_registrations"
  ("tenant_id", "mcp_server_id", "binding_fingerprint");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_client_registrations_maintenance_idx"
  ON "mcp_oauth_client_registrations"
  ("status", "lease_expires_at", "client_secret_expires_at", "finished_at");
--> statement-breakpoint
ALTER TABLE "mcp_oauth_client_registrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_client_registrations" FORCE ROW LEVEL SECURITY;
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
