-- DB-backed Knowledge feature skeleton.
-- Design: docs/internal/knowledge-graph-design-2026-06-02.md
--
-- Baseline CRUD/history works on SQLite and Postgres. Advanced features
-- (Postgres FTS, pg_trgm autocomplete, pgvector, optional graph extension)
-- intentionally land in later migrations.

CREATE TABLE "kb_namespaces" (
	"namespace_id" varchar(36) PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'global' NOT NULL,
	"owner_user_id" varchar(36),
	"repo_id" varchar(36),
	"branch_id" varchar(36),
	"visibility_default" text DEFAULT 'public' NOT NULL,
	"metadata" jsonb,
	"created_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "kb_namespaces" ADD CONSTRAINT "kb_namespaces_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_namespaces" ADD CONSTRAINT "kb_namespaces_repo_id_repos_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "repos"("repo_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_namespaces" ADD CONSTRAINT "kb_namespaces_branch_id_branches_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("branch_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_namespaces" ADD CONSTRAINT "kb_namespaces_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_namespaces_slug_idx" ON "kb_namespaces" ("slug") WHERE "archived" = false;--> statement-breakpoint
CREATE INDEX "kb_namespaces_kind_idx" ON "kb_namespaces" ("kind");--> statement-breakpoint
CREATE INDEX "kb_namespaces_owner_idx" ON "kb_namespaces" ("owner_user_id");--> statement-breakpoint
CREATE INDEX "kb_namespaces_repo_idx" ON "kb_namespaces" ("repo_id");--> statement-breakpoint
CREATE INDEX "kb_namespaces_branch_idx" ON "kb_namespaces" ("branch_id");--> statement-breakpoint
CREATE INDEX "kb_namespaces_archived_idx" ON "kb_namespaces" ("archived");--> statement-breakpoint

INSERT INTO "kb_namespaces" (
	namespace_id, slug, display_name, description, kind,
	visibility_default, metadata, created_by, created_at, updated_at, archived
)
VALUES
	('00000000-0000-7000-8000-000000000001', 'global', 'Global', 'Shared instance-wide Knowledge space.', 'global', 'public', NULL, NULL, now(), now(), false),
	('00000000-0000-7000-8000-000000000002', 'skills', 'Skills', 'Shared markdown skills for agents and teammates.', 'global', 'public', NULL, NULL, now(), now(), false);--> statement-breakpoint

CREATE TABLE "kb_documents" (
	"document_id" varchar(36) PRIMARY KEY NOT NULL,
	"namespace_id" varchar(36) NOT NULL,
	"path" text NOT NULL,
	"uri" text NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'doc' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"edit_policy" text DEFAULT 'owner' NOT NULL,
	"current_version_id" varchar(36),
	"metadata" jsonb,
	"created_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_by" varchar(36),
	"updated_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_namespace_id_kb_namespaces_namespace_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "kb_namespaces"("namespace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_updated_by_users_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_namespace_path_idx" ON "kb_documents" ("namespace_id","path") WHERE "archived" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_uri_idx" ON "kb_documents" ("uri") WHERE "archived" = false;--> statement-breakpoint
CREATE INDEX "kb_documents_namespace_idx" ON "kb_documents" ("namespace_id");--> statement-breakpoint
CREATE INDEX "kb_documents_kind_idx" ON "kb_documents" ("kind");--> statement-breakpoint
CREATE INDEX "kb_documents_visibility_idx" ON "kb_documents" ("visibility");--> statement-breakpoint
CREATE INDEX "kb_documents_created_by_idx" ON "kb_documents" ("created_by");--> statement-breakpoint
CREATE INDEX "kb_documents_updated_at_idx" ON "kb_documents" ("updated_at");--> statement-breakpoint
CREATE INDEX "kb_documents_archived_idx" ON "kb_documents" ("archived");--> statement-breakpoint

CREATE TABLE "kb_document_versions" (
	"version_id" varchar(36) PRIMARY KEY NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"version_number" integer NOT NULL,
	"content_text" text,
	"content_blob" bytea,
	"mime_type" text DEFAULT 'text/markdown' NOT NULL,
	"content_md5" text,
	"content_sha256" text,
	"byte_length" integer,
	"char_length" integer,
	"frontmatter" jsonb,
	"metadata" jsonb,
	"change_summary" text,
	"created_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "kb_document_versions" ADD CONSTRAINT "kb_document_versions_document_id_kb_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_document_versions" ADD CONSTRAINT "kb_document_versions_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_document_versions_document_version_idx" ON "kb_document_versions" ("document_id","version_number");--> statement-breakpoint
CREATE INDEX "kb_document_versions_document_idx" ON "kb_document_versions" ("document_id");--> statement-breakpoint
CREATE INDEX "kb_document_versions_created_idx" ON "kb_document_versions" ("created_at");--> statement-breakpoint
CREATE INDEX "kb_document_versions_md5_idx" ON "kb_document_versions" ("content_md5");--> statement-breakpoint

CREATE TABLE "kb_document_units" (
	"unit_id" varchar(36) PRIMARY KEY NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"kind" text DEFAULT 'document' NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"path_anchor" text,
	"heading_path" text,
	"source_path" text,
	"content_text" text,
	"content_md5" text,
	"start_offset" integer,
	"end_offset" integer,
	"embedding_status" text DEFAULT 'not_configured' NOT NULL,
	"embedding_model" text,
	"embedding_dimensions" integer,
	"embedding_hash" text,
	"embedding_error" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD CONSTRAINT "kb_document_units_document_id_kb_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD CONSTRAINT "kb_document_units_version_id_kb_document_versions_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "kb_document_versions"("version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_document_units_document_idx" ON "kb_document_units" ("document_id");--> statement-breakpoint
CREATE INDEX "kb_document_units_version_idx" ON "kb_document_units" ("version_id");--> statement-breakpoint
CREATE INDEX "kb_document_units_content_hash_idx" ON "kb_document_units" ("content_md5");--> statement-breakpoint
CREATE INDEX "kb_document_units_embedding_status_idx" ON "kb_document_units" ("embedding_status");--> statement-breakpoint
CREATE INDEX "kb_document_units_version_ordinal_idx" ON "kb_document_units" ("version_id","ordinal");--> statement-breakpoint

CREATE TABLE "kb_graph_nodes" (
	"node_id" varchar(36) PRIMARY KEY NOT NULL,
	"node_type" text NOT NULL,
	"uri" text NOT NULL,
	"label" text,
	"namespace_id" varchar(36),
	"document_id" varchar(36),
	"unit_id" varchar(36),
	"branch_id" varchar(36),
	"session_id" varchar(36),
	"task_id" varchar(36),
	"message_id" varchar(36),
	"artifact_id" varchar(36),
	"repo_id" varchar(36),
	"board_id" varchar(36),
	"user_id" varchar(36),
	"external_uri" text,
	"metadata" jsonb,
	"created_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_namespace_id_kb_namespaces_namespace_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "kb_namespaces"("namespace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_document_id_kb_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_unit_id_kb_document_units_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "kb_document_units"("unit_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_branch_id_branches_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "branches"("branch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_message_id_messages_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_artifact_id_artifacts_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_repo_id_repos_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "repos"("repo_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "boards"("board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD CONSTRAINT "kb_graph_nodes_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_graph_nodes_uri_idx" ON "kb_graph_nodes" ("uri") WHERE "archived" = false;--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_type_idx" ON "kb_graph_nodes" ("node_type");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_namespace_idx" ON "kb_graph_nodes" ("namespace_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_document_idx" ON "kb_graph_nodes" ("document_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_unit_idx" ON "kb_graph_nodes" ("unit_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_branch_idx" ON "kb_graph_nodes" ("branch_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_session_idx" ON "kb_graph_nodes" ("session_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_task_idx" ON "kb_graph_nodes" ("task_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_message_idx" ON "kb_graph_nodes" ("message_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_artifact_idx" ON "kb_graph_nodes" ("artifact_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_repo_idx" ON "kb_graph_nodes" ("repo_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_board_idx" ON "kb_graph_nodes" ("board_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_user_idx" ON "kb_graph_nodes" ("user_id");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_external_uri_idx" ON "kb_graph_nodes" ("external_uri");--> statement-breakpoint
CREATE INDEX "kb_graph_nodes_archived_idx" ON "kb_graph_nodes" ("archived");--> statement-breakpoint

CREATE TABLE "kb_graph_edges" (
	"edge_id" varchar(36) PRIMARY KEY NOT NULL,
	"source_node_id" varchar(36) NOT NULL,
	"target_node_id" varchar(36) NOT NULL,
	"edge_type" text NOT NULL,
	"confidence" integer,
	"properties" jsonb,
	"created_by" varchar(36),
	"created_at" timestamp with time zone NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "kb_graph_edges" ADD CONSTRAINT "kb_graph_edges_source_node_id_kb_graph_nodes_node_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "kb_graph_nodes"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_edges" ADD CONSTRAINT "kb_graph_edges_target_node_id_kb_graph_nodes_node_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "kb_graph_nodes"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_graph_edges" ADD CONSTRAINT "kb_graph_edges_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_graph_edges_source_idx" ON "kb_graph_edges" ("source_node_id");--> statement-breakpoint
CREATE INDEX "kb_graph_edges_target_idx" ON "kb_graph_edges" ("target_node_id");--> statement-breakpoint
CREATE INDEX "kb_graph_edges_type_idx" ON "kb_graph_edges" ("edge_type");--> statement-breakpoint
CREATE INDEX "kb_graph_edges_source_type_idx" ON "kb_graph_edges" ("source_node_id","edge_type");--> statement-breakpoint
CREATE INDEX "kb_graph_edges_target_type_idx" ON "kb_graph_edges" ("target_node_id","edge_type");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_graph_edges_source_target_type_idx" ON "kb_graph_edges" ("source_node_id","target_node_id","edge_type") WHERE "archived" = false;--> statement-breakpoint
CREATE INDEX "kb_graph_edges_archived_idx" ON "kb_graph_edges" ("archived");
