SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "tenant_restrictions" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "controller_id" text NOT NULL,
  "placement_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "revision" bigint NOT NULL,
  "phase" text NOT NULL,
  "protocol_version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "controller_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_restrictions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_restrictions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_tenant_restrictions" ON "tenant_restrictions"
  USING (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
  )
  WITH CHECK (
    COALESCE(current_setting('agor.system_scope', true), '') = ''
    AND "tenant_id" = NULLIF(current_setting('agor.tenant_id', true), '')
  );
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
