ALTER TABLE `tasks` ADD `executor_connected_at` integer;--> statement-breakpoint
UPDATE `tasks` SET `queue_position` = NULL WHERE `status` <> 'queued';
