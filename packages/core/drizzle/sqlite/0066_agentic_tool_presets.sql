CREATE TABLE `agentic_tool_presets` (
	`preset_id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`configuration` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agentic_tool_presets_tool_name_unique` ON `agentic_tool_presets` (`tool`,`name`);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `agentic_tool_preset_id` text(36) REFERENCES agentic_tool_presets(preset_id) ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE `schedules` ADD `agentic_tool_preset_id` text(36) REFERENCES agentic_tool_presets(preset_id) ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE `gateway_channels` ADD `agentic_tool_preset_id` text(36) REFERENCES agentic_tool_presets(preset_id) ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX `sessions_agentic_tool_preset_idx` ON `sessions` (`agentic_tool_preset_id`);
--> statement-breakpoint
CREATE INDEX `schedules_agentic_tool_preset_idx` ON `schedules` (`agentic_tool_preset_id`);
--> statement-breakpoint
CREATE INDEX `gateway_channels_agentic_tool_preset_idx` ON `gateway_channels` (`agentic_tool_preset_id`);
