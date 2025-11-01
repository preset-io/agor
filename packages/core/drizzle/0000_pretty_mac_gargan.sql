CREATE TABLE `board_comments` (
	`comment_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`board_id` text(36) NOT NULL,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`session_id` text(36),
	`task_id` text(36),
	`message_id` text(36),
	`worktree_id` text(36),
	`content` text NOT NULL,
	`content_preview` text NOT NULL,
	`parent_comment_id` text(36),
	`resolved` integer DEFAULT false NOT NULL,
	`edited` integer DEFAULT false NOT NULL,
	`reactions` text DEFAULT '[]' NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `board_comments_board_idx` ON `board_comments` (`board_id`);--> statement-breakpoint
CREATE INDEX `board_comments_session_idx` ON `board_comments` (`session_id`);--> statement-breakpoint
CREATE INDEX `board_comments_task_idx` ON `board_comments` (`task_id`);--> statement-breakpoint
CREATE INDEX `board_comments_message_idx` ON `board_comments` (`message_id`);--> statement-breakpoint
CREATE INDEX `board_comments_worktree_idx` ON `board_comments` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `board_comments_created_by_idx` ON `board_comments` (`created_by`);--> statement-breakpoint
CREATE INDEX `board_comments_parent_idx` ON `board_comments` (`parent_comment_id`);--> statement-breakpoint
CREATE INDEX `board_comments_created_idx` ON `board_comments` (`created_at`);--> statement-breakpoint
CREATE INDEX `board_comments_resolved_idx` ON `board_comments` (`resolved`);--> statement-breakpoint
CREATE TABLE `board_objects` (
	`object_id` text(36) PRIMARY KEY NOT NULL,
	`board_id` text(36) NOT NULL,
	`created_at` integer NOT NULL,
	`worktree_id` text(36) NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `board_objects_board_idx` ON `board_objects` (`board_id`);--> statement-breakpoint
CREATE INDEX `board_objects_worktree_idx` ON `board_objects` (`worktree_id`);--> statement-breakpoint
CREATE TABLE `boards` (
	`board_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_slug_unique` ON `boards` (`slug`);--> statement-breakpoint
CREATE INDEX `boards_name_idx` ON `boards` (`name`);--> statement-breakpoint
CREATE INDEX `boards_slug_idx` ON `boards` (`slug`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`mcp_server_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`scope` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`owner_user_id` text(36),
	`team_id` text(36),
	`repo_id` text(36),
	`session_id` text(36),
	`source` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`repo_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_servers_name_idx` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE INDEX `mcp_servers_scope_idx` ON `mcp_servers` (`scope`);--> statement-breakpoint
CREATE INDEX `mcp_servers_owner_idx` ON `mcp_servers` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `mcp_servers_team_idx` ON `mcp_servers` (`team_id`);--> statement-breakpoint
CREATE INDEX `mcp_servers_repo_idx` ON `mcp_servers` (`repo_id`);--> statement-breakpoint
CREATE INDEX `mcp_servers_session_idx` ON `mcp_servers` (`session_id`);--> statement-breakpoint
CREATE INDEX `mcp_servers_enabled_idx` ON `mcp_servers` (`enabled`);--> statement-breakpoint
CREATE TABLE `messages` (
	`message_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`session_id` text(36) NOT NULL,
	`task_id` text(36),
	`type` text NOT NULL,
	`role` text NOT NULL,
	`index` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`content_preview` text,
	`data` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `messages_session_id_idx` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `messages_task_id_idx` ON `messages` (`task_id`);--> statement-breakpoint
CREATE INDEX `messages_session_index_idx` ON `messages` (`session_id`,`index`);--> statement-breakpoint
CREATE TABLE `repos` (
	`repo_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`slug` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_slug_unique` ON `repos` (`slug`);--> statement-breakpoint
CREATE INDEX `repos_slug_idx` ON `repos` (`slug`);--> statement-breakpoint
CREATE TABLE `session_mcp_servers` (
	`session_id` text(36) NOT NULL,
	`mcp_server_id` text(36) NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`mcp_server_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_mcp_servers_pk` ON `session_mcp_servers` (`session_id`,`mcp_server_id`);--> statement-breakpoint
CREATE INDEX `session_mcp_servers_session_idx` ON `session_mcp_servers` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_mcp_servers_server_idx` ON `session_mcp_servers` (`mcp_server_id`);--> statement-breakpoint
CREATE INDEX `session_mcp_servers_enabled_idx` ON `session_mcp_servers` (`session_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`status` text NOT NULL,
	`agentic_tool` text NOT NULL,
	`board_id` text(36),
	`parent_session_id` text(36),
	`forked_from_session_id` text(36),
	`worktree_id` text(36) NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`worktree_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `sessions_agentic_tool_idx` ON `sessions` (`agentic_tool`);--> statement-breakpoint
CREATE INDEX `sessions_board_idx` ON `sessions` (`board_id`);--> statement-breakpoint
CREATE INDEX `sessions_worktree_idx` ON `sessions` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `sessions_created_idx` ON `sessions` (`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_parent_idx` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_forked_idx` ON `sessions` (`forked_from_session_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`task_id` text(36) PRIMARY KEY NOT NULL,
	`session_id` text(36) NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`status` text NOT NULL,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_session_idx` ON `tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_created_idx` ON `tasks` (`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`email` text NOT NULL,
	`password` text NOT NULL,
	`name` text,
	`emoji` text,
	`role` text DEFAULT 'member' NOT NULL,
	`onboarding_completed` integer DEFAULT false NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`worktree_id` text(36) PRIMARY KEY NOT NULL,
	`repo_id` text(36) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`name` text NOT NULL,
	`ref` text NOT NULL,
	`worktree_unique_id` integer NOT NULL,
	`board_id` text(36),
	`data` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`repo_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `worktrees_repo_idx` ON `worktrees` (`repo_id`);--> statement-breakpoint
CREATE INDEX `worktrees_name_idx` ON `worktrees` (`name`);--> statement-breakpoint
CREATE INDEX `worktrees_ref_idx` ON `worktrees` (`ref`);--> statement-breakpoint
CREATE INDEX `worktrees_board_idx` ON `worktrees` (`board_id`);--> statement-breakpoint
CREATE INDEX `worktrees_created_idx` ON `worktrees` (`created_at`);--> statement-breakpoint
CREATE INDEX `worktrees_updated_idx` ON `worktrees` (`updated_at`);--> statement-breakpoint
CREATE INDEX `worktrees_repo_name_unique` ON `worktrees` (`repo_id`,`name`);