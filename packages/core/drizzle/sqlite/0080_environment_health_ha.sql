ALTER TABLE `branches` ADD `environment_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `branches` ADD `environment_health_claim_token` text;
--> statement-breakpoint
ALTER TABLE `branches` ADD `environment_health_claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `branches` ADD `environment_health_claim_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `branches` ADD `environment_health_next_observation_at` integer;
--> statement-breakpoint
ALTER TABLE `branches` ADD `environment_health_claim_instance_id` text;
--> statement-breakpoint
ALTER TABLE `branches` ADD `environment_health_claim_boot_id` text;
--> statement-breakpoint
ALTER TABLE `branches` ADD `environment_health_claim_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `branches_environment_health_lease_idx` ON `branches` (`archived`,`environment_health_claim_expires_at`,`branch_id`);
