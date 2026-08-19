ALTER TABLE `gateway_channels` ADD COLUMN `provider_probe_claim_token` text;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD COLUMN `provider_probe_lease_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD COLUMN `provider_probe_generation` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD COLUMN `provider_probe_config_generation` integer;
--> statement-breakpoint

CREATE INDEX `gateway_channels_provider_probe_lease_idx`
  ON `gateway_channels` (`provider_probe_lease_expires_at`, `id`);
