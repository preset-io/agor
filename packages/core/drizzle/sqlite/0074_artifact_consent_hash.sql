ALTER TABLE `artifact_trust_grants` ADD `artifact_hash` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `artifact_trust_grants` ADD `allow_introspection` integer DEFAULT false NOT NULL;
