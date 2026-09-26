ALTER TABLE `repos` ADD `cleanup_policy` text DEFAULT '{"enabled":false,"command":"git clean -fdX","allow_branch_protection":true}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `branches` ADD `cleanup_protected` integer DEFAULT false NOT NULL;
