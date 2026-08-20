-- Keep caller-generated prompt retry identities separate from server Task IDs.
ALTER TABLE `tasks` ADD COLUMN `prompt_idempotency_key` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `prompt_request_fingerprint` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_prompt_idempotency_unique` ON `tasks` (`created_by`,`session_id`,`prompt_idempotency_key`) WHERE `prompt_idempotency_key` IS NOT NULL;
