-- Provider configuration is a durable authorization revision, distinct from
-- listener generation. Healthy listener takeover must not invalidate queued
-- finals; credential/binding/scope changes must.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "gateway_channels"
  ADD COLUMN "provider_config_generation" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE "gateway_provider_actions" (
  "tenant_id" text DEFAULT 'default' NOT NULL,
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "gateway_channel_id" varchar(36) NOT NULL REFERENCES "gateway_channels"("id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  "channel_type" text NOT NULL,
  "provider_installation_id" text NOT NULL,
  "provider_config_generation" integer NOT NULL,
  "kind" text NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "thread_session_map_id" varchar(36) REFERENCES "thread_session_map"("id") ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  "session_id" varchar(36) REFERENCES "sessions"("session_id") ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  "task_id" varchar(36) REFERENCES "tasks"("task_id") ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  "message_id" varchar(36) REFERENCES "messages"("message_id") ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  "gateway_inbound_event_id" varchar(36) REFERENCES "gateway_inbound_events"("id") ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  "params" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "not_before" timestamp with time zone NOT NULL,
  "claim_token" text,
  "claim_generation" integer DEFAULT 0 NOT NULL,
  "claim_expires_at" timestamp with time zone,
  "claim_listener_token" text,
  "claim_listener_generation" integer,
  "claim_instance_id" text,
  "claim_boot_id" text,
  "last_error_code" varchar(64),
  "result_metadata" jsonb,
  "completed_at" timestamp with time zone,
  "dead_lettered_at" timestamp with time zone,
  "canceled_at" timestamp with time zone,
  CONSTRAINT "gateway_provider_actions_idempotency_key_bounds" CHECK (octet_length("idempotency_key") BETWEEN 1 AND 200),
  CONSTRAINT "gateway_provider_actions_params_bounds" CHECK (octet_length("params"::text) <= 512),
  CONSTRAINT "gateway_provider_actions_result_bounds" CHECK ("result_metadata" IS NULL OR octet_length("result_metadata"::text) <= 256),
  CONSTRAINT "gateway_provider_actions_lifecycle_bounds" CHECK ("provider_config_generation" > 0 AND "attempts" >= 0 AND "claim_generation" >= 0),
  CONSTRAINT "gateway_provider_actions_error_code_format" CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "gateway_provider_actions_kind_check" CHECK ("kind" = 'deliver_message'),
  CONSTRAINT "gateway_provider_actions_status_check" CHECK ("status" IN ('pending', 'processing', 'retry', 'completed', 'dead_letter', 'canceled'))
);
--> statement-breakpoint
CREATE INDEX "gateway_provider_actions_tenant_id_idx"
  ON "gateway_provider_actions" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_provider_actions_tenant_channel_generation_key_unique"
  ON "gateway_provider_actions" ("tenant_id", "gateway_channel_id", "provider_config_generation", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "gateway_provider_actions_backlog_idx"
  ON "gateway_provider_actions" ("tenant_id", "gateway_channel_id", "status", "not_before", "id");
--> statement-breakpoint
CREATE INDEX "gateway_provider_actions_claim_idx"
  ON "gateway_provider_actions" ("tenant_id", "gateway_channel_id", "status", "claim_expires_at", "id");
--> statement-breakpoint
ALTER TABLE "gateway_provider_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gateway_provider_actions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_gateway_provider_actions" ON "gateway_provider_actions"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
