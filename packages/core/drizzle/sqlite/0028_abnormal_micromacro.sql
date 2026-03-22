CREATE TABLE `card_types` (
	`card_type_id` text(36) PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`emoji` text,
	`color` text,
	`json_schema` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `card_types_name_idx` ON `card_types` (`name`);--> statement-breakpoint
CREATE TABLE `cards` (
	`card_id` text(36) PRIMARY KEY NOT NULL,
	`board_id` text(36) NOT NULL,
	`card_type_id` text(36),
	`title` text NOT NULL,
	`url` text,
	`description` text,
	`note` text,
	`data` text,
	`color_override` text,
	`emoji_override` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_type_id`) REFERENCES `card_types`(`card_type_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cards_board_idx` ON `cards` (`board_id`);--> statement-breakpoint
CREATE INDEX `cards_card_type_idx` ON `cards` (`card_type_id`);--> statement-breakpoint
CREATE INDEX `cards_title_idx` ON `cards` (`title`);--> statement-breakpoint
CREATE INDEX `cards_archived_idx` ON `cards` (`archived`);--> statement-breakpoint
CREATE INDEX `cards_created_idx` ON `cards` (`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_board_objects` (
	`object_id` text(36) PRIMARY KEY NOT NULL,
	`board_id` text(36) NOT NULL,
	`created_at` integer NOT NULL,
	`worktree_id` text(36),
	`card_id` text(36),
	`data` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`card_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_board_objects`("object_id", "board_id", "created_at", "worktree_id", "card_id", "data") SELECT "object_id", "board_id", "created_at", "worktree_id", NULL, "data" FROM `board_objects`;--> statement-breakpoint
DROP TABLE `board_objects`;--> statement-breakpoint
ALTER TABLE `__new_board_objects` RENAME TO `board_objects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `board_objects_board_idx` ON `board_objects` (`board_id`);--> statement-breakpoint
CREATE INDEX `board_objects_worktree_idx` ON `board_objects` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `board_objects_card_idx` ON `board_objects` (`card_id`);