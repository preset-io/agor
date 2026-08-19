SET LOCAL lock_timeout = '3s';
--> statement-breakpoint

ALTER TABLE "gateway_channels"
  ADD COLUMN "provider_probe_claim_token" text,
  ADD COLUMN "provider_probe_lease_expires_at" timestamp with time zone,
  ADD COLUMN "provider_probe_generation" integer NOT NULL DEFAULT 0,
  ADD COLUMN "provider_probe_config_generation" integer;
--> statement-breakpoint

CREATE INDEX "gateway_channels_provider_probe_lease_idx"
  ON "gateway_channels" ("tenant_id", "provider_probe_lease_expires_at", "id");
