ALTER TABLE "gateway_channels" ADD COLUMN "listener_claim_token" text;
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "listener_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "listener_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "listener_instance_id" text;
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "listener_boot_id" text;
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "listener_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "listener_checkpoint" jsonb;
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "listener_checkpoint_updated_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "gateway_channels_listener_lease_idx" ON "gateway_channels" ("tenant_id","enabled","listener_lease_expires_at","id");
--> statement-breakpoint
CREATE INDEX "gateway_channels_listener_discovery_idx" ON "gateway_channels" ("enabled","tenant_id","id");
--> statement-breakpoint
CREATE TABLE "gateway_inbound_events" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "gateway_channel_id" varchar(36) NOT NULL REFERENCES "gateway_channels"("id") ON DELETE CASCADE,
  "provider_event_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "delivery_metadata" jsonb,
  "status" text NOT NULL,
  "processing_token" text NOT NULL,
  "processing_expires_at" timestamp with time zone NOT NULL,
  "session_id" varchar(36) REFERENCES "sessions"("session_id") ON DELETE SET NULL,
  "task_id" varchar(36) REFERENCES "tasks"("task_id") ON DELETE SET NULL,
  "received_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "gateway_inbound_events_tenant_id_idx" ON "gateway_inbound_events" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_inbound_events_tenant_provider_unique" ON "gateway_inbound_events" ("tenant_id","gateway_channel_id","provider_event_id");
--> statement-breakpoint
CREATE INDEX "gateway_inbound_events_recovery_idx" ON "gateway_inbound_events" ("tenant_id","status","processing_expires_at","id");
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_gateway_inbound_events" ON "gateway_inbound_events"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
