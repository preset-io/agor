-- DB-backed Knowledge feature skeleton.
-- Design: docs/internal/knowledge-graph-design-2026-06-02.md
--
-- Baseline CRUD/history works on SQLite and Postgres. Advanced features
-- (Postgres FTS, pg_trgm autocomplete, pgvector, optional graph extension)
-- intentionally land in later migrations. Enum-like text columns are validated
-- at the service/type layer; no SQLite CHECK constraints per migration gotchas.

CREATE TABLE `kb_namespaces` (
	`namespace_id` text(36) PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'global' NOT NULL,
	`owner_user_id` text(36),
	`repo_id` text(36),
	`branch_id` text(36),
	`visibility_default` text DEFAULT 'public' NOT NULL,
	`metadata` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`repo_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `kb_namespaces_slug_idx` ON `kb_namespaces` (`slug`) WHERE `archived` = false;--> statement-breakpoint
CREATE INDEX `kb_namespaces_kind_idx` ON `kb_namespaces` (`kind`);--> statement-breakpoint
CREATE INDEX `kb_namespaces_owner_idx` ON `kb_namespaces` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `kb_namespaces_repo_idx` ON `kb_namespaces` (`repo_id`);--> statement-breakpoint
CREATE INDEX `kb_namespaces_branch_idx` ON `kb_namespaces` (`branch_id`);--> statement-breakpoint
CREATE INDEX `kb_namespaces_archived_idx` ON `kb_namespaces` (`archived`);--> statement-breakpoint

INSERT INTO `kb_namespaces` (
	namespace_id, slug, display_name, description, kind,
	visibility_default, metadata, created_by, created_at, updated_at, archived
)
VALUES
	('00000000-0000-7000-8000-000000000001', 'global', 'Global', 'Shared instance-wide Knowledge space.', 'global', 'public', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000, false),
	('00000000-0000-7000-8000-000000000002', 'skills', 'Skills', 'Shared markdown skills for agents and teammates.', 'global', 'public', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000, false);--> statement-breakpoint

CREATE TABLE `kb_documents` (
	`document_id` text(36) PRIMARY KEY NOT NULL,
	`namespace_id` text(36) NOT NULL,
	`path` text NOT NULL,
	`uri` text NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT 'doc' NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`edit_policy` text DEFAULT 'owner' NOT NULL,
	`current_version_id` text(36),
	`metadata` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_by` text(36),
	`updated_at` integer,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`namespace_id`) REFERENCES `kb_namespaces`(`namespace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `kb_documents_namespace_path_idx` ON `kb_documents` (`namespace_id`,`path`) WHERE `archived` = false;--> statement-breakpoint
CREATE UNIQUE INDEX `kb_documents_uri_idx` ON `kb_documents` (`uri`) WHERE `archived` = false;--> statement-breakpoint
CREATE INDEX `kb_documents_namespace_idx` ON `kb_documents` (`namespace_id`);--> statement-breakpoint
CREATE INDEX `kb_documents_kind_idx` ON `kb_documents` (`kind`);--> statement-breakpoint
CREATE INDEX `kb_documents_visibility_idx` ON `kb_documents` (`visibility`);--> statement-breakpoint
CREATE INDEX `kb_documents_created_by_idx` ON `kb_documents` (`created_by`);--> statement-breakpoint
CREATE INDEX `kb_documents_updated_at_idx` ON `kb_documents` (`updated_at`);--> statement-breakpoint
CREATE INDEX `kb_documents_archived_idx` ON `kb_documents` (`archived`);--> statement-breakpoint

CREATE TABLE `kb_document_versions` (
	`version_id` text(36) PRIMARY KEY NOT NULL,
	`document_id` text(36) NOT NULL,
	`version_number` integer NOT NULL,
	`content_text` text,
	`content_blob` blob,
	`mime_type` text DEFAULT 'text/markdown' NOT NULL,
	`content_md5` text,
	`content_sha256` text,
	`byte_length` integer,
	`char_length` integer,
	`frontmatter` text,
	`metadata` text,
	`change_summary` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `kb_documents`(`document_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `kb_document_versions_document_version_idx` ON `kb_document_versions` (`document_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `kb_document_versions_document_idx` ON `kb_document_versions` (`document_id`);--> statement-breakpoint
CREATE INDEX `kb_document_versions_created_idx` ON `kb_document_versions` (`created_at`);--> statement-breakpoint
CREATE INDEX `kb_document_versions_md5_idx` ON `kb_document_versions` (`content_md5`);--> statement-breakpoint

CREATE TABLE `kb_document_units` (
	`unit_id` text(36) PRIMARY KEY NOT NULL,
	`document_id` text(36) NOT NULL,
	`version_id` text(36) NOT NULL,
	`kind` text DEFAULT 'document' NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`path_anchor` text,
	`heading_path` text,
	`source_path` text,
	`content_text` text,
	`content_md5` text,
	`start_offset` integer,
	`end_offset` integer,
	`embedding_status` text DEFAULT 'not_configured' NOT NULL,
	`embedding_model` text,
	`embedding_dimensions` integer,
	`embedding_hash` text,
	`embedding_error` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `kb_documents`(`document_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `kb_document_versions`(`version_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `kb_document_units_document_idx` ON `kb_document_units` (`document_id`);--> statement-breakpoint
CREATE INDEX `kb_document_units_version_idx` ON `kb_document_units` (`version_id`);--> statement-breakpoint
CREATE INDEX `kb_document_units_content_hash_idx` ON `kb_document_units` (`content_md5`);--> statement-breakpoint
CREATE INDEX `kb_document_units_embedding_status_idx` ON `kb_document_units` (`embedding_status`);--> statement-breakpoint
CREATE INDEX `kb_document_units_version_ordinal_idx` ON `kb_document_units` (`version_id`,`ordinal`);--> statement-breakpoint

CREATE TABLE `kb_graph_nodes` (
	`node_id` text(36) PRIMARY KEY NOT NULL,
	`node_type` text NOT NULL,
	`uri` text NOT NULL,
	`label` text,
	`namespace_id` text(36),
	`document_id` text(36),
	`unit_id` text(36),
	`branch_id` text(36),
	`session_id` text(36),
	`task_id` text(36),
	`message_id` text(36),
	`artifact_id` text(36),
	`repo_id` text(36),
	`board_id` text(36),
	`user_id` text(36),
	`external_uri` text,
	`metadata` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`namespace_id`) REFERENCES `kb_namespaces`(`namespace_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `kb_documents`(`document_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`unit_id`) REFERENCES `kb_document_units`(`unit_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`artifact_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`repo_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `kb_graph_nodes_uri_idx` ON `kb_graph_nodes` (`uri`) WHERE `archived` = false;--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_type_idx` ON `kb_graph_nodes` (`node_type`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_namespace_idx` ON `kb_graph_nodes` (`namespace_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_document_idx` ON `kb_graph_nodes` (`document_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_unit_idx` ON `kb_graph_nodes` (`unit_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_branch_idx` ON `kb_graph_nodes` (`branch_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_session_idx` ON `kb_graph_nodes` (`session_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_task_idx` ON `kb_graph_nodes` (`task_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_message_idx` ON `kb_graph_nodes` (`message_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_artifact_idx` ON `kb_graph_nodes` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_repo_idx` ON `kb_graph_nodes` (`repo_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_board_idx` ON `kb_graph_nodes` (`board_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_user_idx` ON `kb_graph_nodes` (`user_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_external_uri_idx` ON `kb_graph_nodes` (`external_uri`);--> statement-breakpoint
CREATE INDEX `kb_graph_nodes_archived_idx` ON `kb_graph_nodes` (`archived`);--> statement-breakpoint

CREATE TABLE `kb_graph_edges` (
	`edge_id` text(36) PRIMARY KEY NOT NULL,
	`source_node_id` text(36) NOT NULL,
	`target_node_id` text(36) NOT NULL,
	`edge_type` text NOT NULL,
	`confidence` integer,
	`properties` text,
	`created_by` text(36),
	`created_at` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`source_node_id`) REFERENCES `kb_graph_nodes`(`node_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `kb_graph_nodes`(`node_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `kb_graph_edges_source_idx` ON `kb_graph_edges` (`source_node_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_edges_target_idx` ON `kb_graph_edges` (`target_node_id`);--> statement-breakpoint
CREATE INDEX `kb_graph_edges_type_idx` ON `kb_graph_edges` (`edge_type`);--> statement-breakpoint
CREATE INDEX `kb_graph_edges_source_type_idx` ON `kb_graph_edges` (`source_node_id`,`edge_type`);--> statement-breakpoint
CREATE INDEX `kb_graph_edges_target_type_idx` ON `kb_graph_edges` (`target_node_id`,`edge_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `kb_graph_edges_source_target_type_idx` ON `kb_graph_edges` (`source_node_id`,`target_node_id`,`edge_type`) WHERE `archived` = false;--> statement-breakpoint
CREATE INDEX `kb_graph_edges_archived_idx` ON `kb_graph_edges` (`archived`);
