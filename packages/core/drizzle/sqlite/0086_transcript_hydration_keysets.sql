CREATE INDEX IF NOT EXISTS `tasks_session_task_id_idx` ON `tasks` (`session_id`,`task_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_session_message_id_idx` ON `messages` (`session_id`,`message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_task_message_id_idx` ON `messages` (`task_id`,`message_id`);
