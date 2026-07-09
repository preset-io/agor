ALTER TABLE `boards` ADD `primary_teammate_id` text(36);--> statement-breakpoint
UPDATE boards
SET primary_teammate_id = primary_assistant_id
WHERE primary_teammate_id IS NULL
  AND primary_assistant_id IS NOT NULL;
