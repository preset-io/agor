CREATE TABLE `mcp_catalog_entries` (
	`catalog_entry_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`name` text NOT NULL,
	`version` text,
	`registry_updated_at` integer,
	`title` text,
	`description` text,
	`website_url` text,
	`repository_url` text,
	`transport` text,
	`remote_url` text,
	`has_remote` integer DEFAULT false NOT NULL,
	`has_package` integer DEFAULT false NOT NULL,
	`curated` integer DEFAULT false NOT NULL,
	`category` text,
	`capability_tags` text,
	`benefit` text,
	`starter_prompt` text,
	`permission_disclosure` text,
	`icon_url` text,
	`verified` integer DEFAULT false NOT NULL,
	`popularity_rank` integer,
	`connect_count` integer DEFAULT 0 NOT NULL,
	`probed_auth_type` text DEFAULT 'unknown' NOT NULL,
	`probed_at` integer,
	`auth_server_origin` text,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_catalog_entries_name_unique` ON `mcp_catalog_entries` (`name`);
--> statement-breakpoint
CREATE INDEX `mcp_catalog_entries_category_idx` ON `mcp_catalog_entries` (`category`);
--> statement-breakpoint
CREATE INDEX `mcp_catalog_entries_verified_idx` ON `mcp_catalog_entries` (`verified`);
--> statement-breakpoint
CREATE INDEX `mcp_catalog_entries_curated_idx` ON `mcp_catalog_entries` (`curated`);
--> statement-breakpoint
CREATE INDEX `mcp_catalog_entries_popularity_idx` ON `mcp_catalog_entries` (`popularity_rank`);
--> statement-breakpoint
CREATE INDEX `mcp_catalog_entries_probed_at_idx` ON `mcp_catalog_entries` (`probed_at`);
