ALTER TABLE `messages` ADD `status` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `queue_position` integer;--> statement-breakpoint
CREATE INDEX `messages_queue_idx` ON `messages` (`session_id`,`status`,`queue_position`);