-- Materialize only token-verified provider identities. This is an intentional
-- system-global boundary: one Discord application has one Gateway event stream.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "provider_installation_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_channels_provider_installation_unique"
  ON "gateway_channels" ("channel_type", "provider_installation_id")
  WHERE "provider_installation_id" IS NOT NULL;
