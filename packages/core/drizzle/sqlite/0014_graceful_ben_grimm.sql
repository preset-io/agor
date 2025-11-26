PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mcp_servers` (
	`mcp_server_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`scope` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`owner_user_id` text(36),
	`source` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_mcp_servers`("mcp_server_id", "created_at", "updated_at", "name", "transport", "scope", "enabled", "owner_user_id", "source", "data") SELECT "mcp_server_id", "created_at", "updated_at", "name", "transport", "scope", "enabled", "owner_user_id", "source", "data" FROM `mcp_servers`;--> statement-breakpoint
DROP TABLE `mcp_servers`;--> statement-breakpoint
ALTER TABLE `__new_mcp_servers` RENAME TO `mcp_servers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `mcp_servers_name_idx` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE INDEX `mcp_servers_scope_idx` ON `mcp_servers` (`scope`);--> statement-breakpoint
CREATE INDEX `mcp_servers_owner_idx` ON `mcp_servers` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `mcp_servers_enabled_idx` ON `mcp_servers` (`enabled`);