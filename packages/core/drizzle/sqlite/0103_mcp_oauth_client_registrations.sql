-- Cross-dialect schema mirror. Standalone SQLite keeps its existing
-- process-local Dynamic Client Registration behavior.
CREATE TABLE `mcp_oauth_client_registrations` (
  `registration_id` text PRIMARY KEY NOT NULL,
  `mcp_server_id` text NOT NULL,
  `registration_generation` integer NOT NULL,
  `binding_version` integer NOT NULL,
  `binding_fingerprint` text NOT NULL,
  `server_config_version` integer NOT NULL,
  `envelope_version` integer NOT NULL,
  `is_current` integer DEFAULT 1 NOT NULL,
  `status` text DEFAULT 'registering' NOT NULL,
  `sealed_material` text,
  `claim_id` text,
  `claim_generation` integer DEFAULT 0 NOT NULL,
  `lease_expires_at` integer,
  `dispatched_at` integer,
  `client_secret_expires_at` integer,
  `failure_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `finished_at` integer,
  FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`mcp_server_id`)
    ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_oauth_client_registrations_current_server_uq`
  ON `mcp_oauth_client_registrations` (`mcp_server_id`)
  WHERE `is_current` = 1;
--> statement-breakpoint
CREATE INDEX `mcp_oauth_client_registrations_server_idx`
  ON `mcp_oauth_client_registrations`
  (`mcp_server_id`, `registration_generation`);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_client_registrations_binding_idx`
  ON `mcp_oauth_client_registrations`
  (`mcp_server_id`, `binding_fingerprint`);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_client_registrations_maintenance_idx`
  ON `mcp_oauth_client_registrations`
  (`status`, `lease_expires_at`, `client_secret_expires_at`, `finished_at`);
