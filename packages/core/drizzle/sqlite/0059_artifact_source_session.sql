ALTER TABLE `artifacts` ADD `source_session_id` text(36);--> statement-breakpoint
CREATE INDEX `artifacts_source_session_idx` ON `artifacts` (`source_session_id`);
