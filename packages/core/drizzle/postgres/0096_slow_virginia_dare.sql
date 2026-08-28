SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
-- Teams gateway HA: authenticated activities are encrypted before queueing;
-- workers and outbound delivery use durable claims rather than process memory.
ALTER TABLE "gateway_inbound_events" ADD COLUMN "payload_encrypted" text;
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" ADD COLUMN "payload_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" ADD COLUMN "provider_config_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" ADD COLUMN "verified_app_id" text;
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" ADD COLUMN "verified_tenant_id" text;
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" ADD COLUMN "last_error_code" text;
--> statement-breakpoint
ALTER TABLE "gateway_inbound_events" ALTER COLUMN "next_attempt_at" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "thread_session_map" ADD COLUMN "teams_last_admitted_activity_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_channels_teams_installation_unique" ON "gateway_channels" USING btree ("channel_type","provider_installation_id") WHERE "gateway_channels"."channel_type" = 'teams' AND "gateway_channels"."enabled" = true AND "gateway_channels"."provider_installation_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "teams_conversation_addresses" (
	"tenant_id" text NOT NULL,
	"address_id" varchar(36) PRIMARY KEY NOT NULL,
	"gateway_channel_id" varchar(36) NOT NULL,
	"thread_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"root_message_id" text,
	"encrypted_address" text NOT NULL,
	"verified_app_id" text NOT NULL,
	"verified_tenant_id" text NOT NULL,
	"provider_config_generation" integer NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "teams_conversation_addresses_gateway_channel_fk" FOREIGN KEY ("gateway_channel_id") REFERENCES "public"."gateway_channels"("id") ON DELETE cascade DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "teams_conversation_addresses_tenant_id_idx" ON "teams_conversation_addresses" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_conversation_addresses_tenant_channel_thread_unique" ON "teams_conversation_addresses" USING btree ("tenant_id","gateway_channel_id","thread_id");
--> statement-breakpoint
CREATE INDEX "teams_conversation_addresses_conversation_idx" ON "teams_conversation_addresses" USING btree ("tenant_id","gateway_channel_id","conversation_id");
--> statement-breakpoint
CREATE TABLE "teams_message_deliveries" (
	"tenant_id" text NOT NULL,
	"delivery_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"message_id" varchar(36) NOT NULL,
	"gateway_channel_id" varchar(36) NOT NULL,
	"thread_session_map_id" varchar(36) NOT NULL,
	"provider_installation_id" text NOT NULL,
	"provider_config_generation" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"claim_generation" integer DEFAULT 0 NOT NULL,
	"effect_started_at" timestamp with time zone,
	"last_error_code" text,
	"provider_message_id" text,
	"completed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	CONSTRAINT "teams_message_deliveries_message_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("message_id") ON DELETE cascade DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "teams_message_deliveries_gateway_channel_fk" FOREIGN KEY ("gateway_channel_id") REFERENCES "public"."gateway_channels"("id") ON DELETE cascade DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "teams_message_deliveries_thread_map_fk" FOREIGN KEY ("thread_session_map_id") REFERENCES "public"."thread_session_map"("id") ON DELETE cascade DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "teams_message_deliveries_tenant_id_idx" ON "teams_message_deliveries" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "teams_message_deliveries_tenant_message_map_unique" ON "teams_message_deliveries" USING btree ("tenant_id","message_id","thread_session_map_id");
--> statement-breakpoint
CREATE INDEX "teams_message_deliveries_due_idx" ON "teams_message_deliveries" USING btree ("tenant_id","status","next_attempt_at","delivery_id");
--> statement-breakpoint
CREATE INDEX "teams_message_deliveries_claim_idx" ON "teams_message_deliveries" USING btree ("tenant_id","status","claim_expires_at","delivery_id");
--> statement-breakpoint
ALTER TABLE "teams_conversation_addresses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "teams_conversation_addresses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_teams_conversation_addresses" ON "teams_conversation_addresses"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "teams_message_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "teams_message_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_teams_message_deliveries" ON "teams_message_deliveries"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
CREATE POLICY "teams_message_delivery_discovery" ON "teams_message_deliveries"
  FOR SELECT
  USING (current_setting('agor.system_scope', true) = 'teams_message_delivery_discovery');
--> statement-breakpoint
CREATE POLICY "teams_gateway_inbound_discovery" ON "gateway_inbound_events"
  FOR SELECT
  USING (current_setting('agor.system_scope', true) = 'teams_gateway_ingress_discovery');
--> statement-breakpoint
CREATE POLICY "teams_gateway_ingress_discovery" ON "gateway_channels"
  FOR SELECT
  USING (
    "enabled" = true
    AND "channel_type" = 'teams'
    AND current_setting('agor.system_scope', true) = 'teams_gateway_ingress_discovery'
  );
