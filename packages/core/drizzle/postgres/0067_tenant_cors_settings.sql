CREATE TABLE "tenant_cors_settings" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"settings_id" text DEFAULT 'current' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"origins" jsonb NOT NULL,
	"updated_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tenant_cors_settings_tenant_id_settings_id_pk" PRIMARY KEY("tenant_id","settings_id"),
	CONSTRAINT "tenant_cors_settings_updated_by_users_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "tenant_cors_settings_tenant_id_idx" ON "tenant_cors_settings" USING btree ("tenant_id");
--> statement-breakpoint
CREATE TABLE "tenant_cors_audit_events" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"event_id" varchar(36) PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"added_origins" jsonb NOT NULL,
	"removed_origins" jsonb NOT NULL,
	"actor_user_id" varchar(36),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tenant_cors_audit_tenant_id_idx" ON "tenant_cors_audit_events" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_cors_audit_tenant_revision_unique" ON "tenant_cors_audit_events" USING btree ("tenant_id","revision");
--> statement-breakpoint
CREATE INDEX "tenant_cors_audit_created_at_idx" ON "tenant_cors_audit_events" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "tenant_cors_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_cors_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_tenant_cors_settings" ON "tenant_cors_settings"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "tenant_cors_audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tenant_cors_audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_tenant_cors_audit_events" ON "tenant_cors_audit_events"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
