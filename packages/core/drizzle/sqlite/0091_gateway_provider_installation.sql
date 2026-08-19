-- Materialize only token-verified provider identities. The global partial
-- unique index prevents one Discord application event stream from being
-- connected to multiple gateway channels, including across Cloud tenants.
ALTER TABLE `gateway_channels` ADD COLUMN `provider_installation_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_channels_provider_installation_unique`
  ON `gateway_channels` (`channel_type`, `provider_installation_id`)
  WHERE `provider_installation_id` IS NOT NULL;
