CREATE TABLE `kb_embedding_spaces` (
  `embedding_space_id` text(36) PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `dimensions` integer NOT NULL,
  `storage_type` text DEFAULT 'vector' NOT NULL,
  `distance` text DEFAULT 'cosine' NOT NULL,
  `active` integer DEFAULT true NOT NULL,
  `metadata` text,
  `created_at` integer NOT NULL,
  `updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kb_embedding_spaces_provider_model_idx` ON `kb_embedding_spaces` (`provider`,`model`,`dimensions`,`storage_type`,`distance`);
--> statement-breakpoint
CREATE INDEX `kb_embedding_spaces_active_idx` ON `kb_embedding_spaces` (`active`);
