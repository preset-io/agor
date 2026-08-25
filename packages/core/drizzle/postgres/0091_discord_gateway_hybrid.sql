SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "provider_installation_id" text;--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "provider_config_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_channels" ALTER COLUMN "agor_user_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_channels_discord_installation_unique" ON "gateway_channels" USING btree ("channel_type","provider_installation_id") WHERE "gateway_channels"."channel_type" = 'discord' AND "gateway_channels"."enabled" = true AND "gateway_channels"."provider_installation_id" IS NOT NULL;

--> statement-breakpoint
ALTER TABLE "thread_session_map" ADD COLUMN "discord_last_admitted_message_id" text;
--> statement-breakpoint
CREATE TABLE "discord_message_deliveries" (
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
	"ambiguous_chunk_index" integer,
	"effect_started_at" timestamp with time zone,
	"effect_recovery_grace_until" timestamp with time zone,
	"chunk_receipts" jsonb NOT NULL,
	"reply_aliases" jsonb NOT NULL,
	"last_error_code" text,
	"completed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "discord_message_deliveries" ADD CONSTRAINT "discord_message_deliveries_message_id_messages_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_message_deliveries" ADD CONSTRAINT "discord_message_deliveries_gateway_channel_id_gateway_channels_id_fk" FOREIGN KEY ("gateway_channel_id") REFERENCES "public"."gateway_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_message_deliveries" ADD CONSTRAINT "discord_message_deliveries_thread_session_map_id_thread_session_map_id_fk" FOREIGN KEY ("thread_session_map_id") REFERENCES "public"."thread_session_map"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_message_deliveries" ALTER CONSTRAINT "discord_message_deliveries_message_id_messages_message_id_fk" DEFERRABLE INITIALLY IMMEDIATE;--> statement-breakpoint
ALTER TABLE "discord_message_deliveries" ALTER CONSTRAINT "discord_message_deliveries_gateway_channel_id_gateway_channels_" DEFERRABLE INITIALLY IMMEDIATE;--> statement-breakpoint
ALTER TABLE "discord_message_deliveries" ALTER CONSTRAINT "discord_message_deliveries_thread_session_map_id_thread_session" DEFERRABLE INITIALLY IMMEDIATE;--> statement-breakpoint
CREATE INDEX "discord_message_deliveries_tenant_id_idx" ON "discord_message_deliveries" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_message_deliveries_message_unique" ON "discord_message_deliveries" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "discord_message_deliveries_due_idx" ON "discord_message_deliveries" USING btree ("tenant_id","status","next_attempt_at","delivery_id");--> statement-breakpoint
CREATE INDEX "discord_message_deliveries_claim_idx" ON "discord_message_deliveries" USING btree ("tenant_id","status","claim_expires_at","delivery_id");
ALTER TABLE "discord_message_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "discord_message_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_discord_message_deliveries" ON "discord_message_deliveries"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
CREATE POLICY "discord_message_delivery_discovery" ON "discord_message_deliveries"
  FOR SELECT
  USING (current_setting('agor.system_scope', true) = 'discord_message_delivery_discovery');
