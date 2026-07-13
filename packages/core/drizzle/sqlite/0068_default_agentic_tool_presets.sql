ALTER TABLE `agentic_tool_presets` ADD `is_default` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `agentic_tool_presets_tenant_tool_default_unique`
ON `agentic_tool_presets` (`tool`)
WHERE `is_default` = 1;
