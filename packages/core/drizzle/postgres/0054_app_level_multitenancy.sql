ALTER TABLE "sessions" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_tenant_id_idx" ON "sessions" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "session_relationships" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_relationships_tenant_id_idx" ON "session_relationships" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_tenant_id_idx" ON "tasks" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "serialized_sessions" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "serialized_sessions_tenant_id_idx" ON "serialized_sessions" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_tenant_id_idx" ON "messages" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "boards_tenant_id_idx" ON "boards" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repos_tenant_id_idx" ON "repos" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branches_tenant_id_idx" ON "branches" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "branch_owners" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branch_owners_tenant_id_idx" ON "branch_owners" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "board_owners" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_owners_tenant_id_idx" ON "board_owners" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_tenant_id_idx" ON "schedules" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_tenant_id_idx" ON "users" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "groups_tenant_id_idx" ON "groups" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "group_memberships" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_memberships_tenant_id_idx" ON "group_memberships" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "branch_group_grants" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branch_group_grants_tenant_id_idx" ON "branch_group_grants" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "board_group_grants" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_group_grants_tenant_id_idx" ON "board_group_grants" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "app_variables" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_variables_tenant_id_idx" ON "app_variables" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "user_api_keys" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_api_keys_tenant_id_idx" ON "user_api_keys" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_tenant_id_idx" ON "mcp_servers" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "card_types" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_types_tenant_id_idx" ON "card_types" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cards_tenant_id_idx" ON "cards" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_tenant_id_idx" ON "artifacts" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "artifact_trust_grants" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_trust_grants_tenant_id_idx" ON "artifact_trust_grants" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "board_objects" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_objects_tenant_id_idx" ON "board_objects" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "session_mcp_servers" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_mcp_servers_tenant_id_idx" ON "session_mcp_servers" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "user_mcp_oauth_tokens" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcp_oauth_tokens_tenant_id_idx" ON "user_mcp_oauth_tokens" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "board_comments" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_comments_tenant_id_idx" ON "board_comments" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "gateway_channels" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_channels_tenant_id_idx" ON "gateway_channels" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "thread_session_map" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_session_map_tenant_id_idx" ON "thread_session_map" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gateway_outbound_messages_tenant_id_idx" ON "gateway_outbound_messages" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "session_env_selections" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_env_selections_tenant_id_idx" ON "session_env_selections" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "kb_namespaces" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_namespaces_tenant_id_idx" ON "kb_namespaces" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "kb_namespace_acl" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_namespace_acl_tenant_id_idx" ON "kb_namespace_acl" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_documents_tenant_id_idx" ON "kb_documents" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "kb_document_versions" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_document_versions_tenant_id_idx" ON "kb_document_versions" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_document_units_tenant_id_idx" ON "kb_document_units" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "kb_embedding_spaces" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_embedding_spaces_tenant_id_idx" ON "kb_embedding_spaces" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_graph_nodes_tenant_id_idx" ON "kb_graph_nodes" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "kb_graph_edges" ADD COLUMN "tenant_id" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_graph_edges_tenant_id_idx" ON "kb_graph_edges" ("tenant_id");
--> statement-breakpoint
ALTER TABLE "boards" DROP CONSTRAINT IF EXISTS "boards_slug_unique";
--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT IF EXISTS "repos_slug_unique";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_unique";
--> statement-breakpoint
ALTER TABLE "gateway_channels" DROP CONSTRAINT IF EXISTS "gateway_channels_channel_key_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "groups_slug_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "app_variables_namespace_key_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_thread_map_channel_thread";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_gateway_outbound_channel_thread";
--> statement-breakpoint
DROP INDEX IF EXISTS "kb_namespaces_slug_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "kb_namespace_acl_namespace_subject_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "kb_documents_namespace_path_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "kb_documents_uri_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "kb_document_versions_document_version_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "kb_embedding_spaces_provider_model_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "kb_graph_nodes_uri_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "kb_graph_edges_source_target_type_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "boards_tenant_slug_unique" ON "boards" ("tenant_id", "slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repos_tenant_slug_unique" ON "repos" ("tenant_id", "slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_email_unique" ON "users" ("tenant_id", "email");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "groups_tenant_slug_unique" ON "groups" ("tenant_id", "slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_variables_tenant_namespace_key_unique" ON "app_variables" ("tenant_id", "namespace", "key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gateway_channels_tenant_channel_key_unique" ON "gateway_channels" ("tenant_id", "channel_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_thread_map_tenant_channel_thread" ON "thread_session_map" ("tenant_id", "channel_id", "thread_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_gateway_outbound_tenant_channel_thread" ON "gateway_outbound_messages" ("tenant_id", "gateway_channel_id", "platform_thread_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_namespaces_tenant_slug_unique" ON "kb_namespaces" ("tenant_id", "slug") WHERE archived = false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_namespace_acl_tenant_namespace_subject_unique" ON "kb_namespace_acl" ("tenant_id", "namespace_id", "subject_type", "subject_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_documents_tenant_namespace_path_unique" ON "kb_documents" ("tenant_id", "namespace_id", "path") WHERE archived = false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_documents_tenant_uri_unique" ON "kb_documents" ("tenant_id", "uri") WHERE archived = false;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_document_versions_tenant_document_version_unique" ON "kb_document_versions" ("tenant_id", "document_id", "version_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_embedding_spaces_tenant_provider_model_unique" ON "kb_embedding_spaces" ("tenant_id", "provider", "model", "dimensions", "storage_type", "distance");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_graph_nodes_tenant_uri_unique" ON "kb_graph_nodes" ("tenant_id", "uri");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_graph_edges_tenant_source_target_type_unique" ON "kb_graph_edges" ("tenant_id", "source_node_id", "target_node_id", "edge_type");
