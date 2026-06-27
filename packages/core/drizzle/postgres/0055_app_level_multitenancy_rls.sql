-- Enable Postgres row-level tenant isolation for tenant-owned tables.
--
-- Static/single-tenant Postgres deployments use the implicit `default` tenant
-- when `agor.tenant_id` has not been set. Cloud deployments should set
-- `agor.tenant_id` for each tenant-scoped transaction; app-layer required
-- mode still fails closed before tenant-owned service access when context is
-- missing.

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_sessions" ON "sessions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_sessions" ON "sessions"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "session_relationships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session_relationships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_session_relationships" ON "session_relationships";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_session_relationships" ON "session_relationships"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_tasks" ON "tasks";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_tasks" ON "tasks"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "serialized_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "serialized_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_serialized_sessions" ON "serialized_sessions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_serialized_sessions" ON "serialized_sessions"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_messages" ON "messages";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_messages" ON "messages"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "boards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "boards" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_boards" ON "boards";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_boards" ON "boards"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "repos" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "repos" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_repos" ON "repos";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_repos" ON "repos"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_branches" ON "branches";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branches" ON "branches"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "branch_owners" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_owners" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_branch_owners" ON "branch_owners";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branch_owners" ON "branch_owners"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "board_owners" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "board_owners" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_board_owners" ON "board_owners";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_board_owners" ON "board_owners"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_schedules" ON "schedules";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_schedules" ON "schedules"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_users" ON "users";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_users" ON "users"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "groups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_groups" ON "groups";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_groups" ON "groups"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "group_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "group_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_group_memberships" ON "group_memberships";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_group_memberships" ON "group_memberships"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "branch_group_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_group_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_branch_group_grants" ON "branch_group_grants";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branch_group_grants" ON "branch_group_grants"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "board_group_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "board_group_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_board_group_grants" ON "board_group_grants";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_board_group_grants" ON "board_group_grants"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "app_variables" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app_variables" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_app_variables" ON "app_variables";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_app_variables" ON "app_variables"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "user_api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_api_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_user_api_keys" ON "user_api_keys";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_user_api_keys" ON "user_api_keys"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "mcp_servers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_servers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_mcp_servers" ON "mcp_servers";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_mcp_servers" ON "mcp_servers"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "card_types" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "card_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_card_types" ON "card_types";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_card_types" ON "card_types"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "cards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cards" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_cards" ON "cards";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_cards" ON "cards"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "artifacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "artifacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_artifacts" ON "artifacts";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_artifacts" ON "artifacts"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "artifact_trust_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "artifact_trust_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_artifact_trust_grants" ON "artifact_trust_grants";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_artifact_trust_grants" ON "artifact_trust_grants"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "board_objects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "board_objects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_board_objects" ON "board_objects";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_board_objects" ON "board_objects"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "session_mcp_servers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session_mcp_servers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_session_mcp_servers" ON "session_mcp_servers";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_session_mcp_servers" ON "session_mcp_servers"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "user_mcp_oauth_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_mcp_oauth_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_user_mcp_oauth_tokens" ON "user_mcp_oauth_tokens";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_user_mcp_oauth_tokens" ON "user_mcp_oauth_tokens"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "board_comments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "board_comments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_board_comments" ON "board_comments";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_board_comments" ON "board_comments"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "gateway_channels" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gateway_channels" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_gateway_channels" ON "gateway_channels";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_gateway_channels" ON "gateway_channels"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "thread_session_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "thread_session_map" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_thread_session_map" ON "thread_session_map";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_thread_session_map" ON "thread_session_map"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gateway_outbound_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_gateway_outbound_messages" ON "gateway_outbound_messages";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_gateway_outbound_messages" ON "gateway_outbound_messages"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "session_env_selections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session_env_selections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_session_env_selections" ON "session_env_selections";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_session_env_selections" ON "session_env_selections"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "kb_namespaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_namespaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_namespaces" ON "kb_namespaces";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_namespaces" ON "kb_namespaces"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "kb_namespace_acl" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_namespace_acl" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_namespace_acl" ON "kb_namespace_acl";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_namespace_acl" ON "kb_namespace_acl"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "kb_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_documents" ON "kb_documents";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_documents" ON "kb_documents"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "kb_document_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_document_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_document_versions" ON "kb_document_versions";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_document_versions" ON "kb_document_versions"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "kb_document_units" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_document_units" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_document_units" ON "kb_document_units";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_document_units" ON "kb_document_units"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "kb_embedding_spaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_embedding_spaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_embedding_spaces" ON "kb_embedding_spaces";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_embedding_spaces" ON "kb_embedding_spaces"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_graph_nodes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_graph_nodes" ON "kb_graph_nodes";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_graph_nodes" ON "kb_graph_nodes"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "kb_graph_edges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_graph_edges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_graph_edges" ON "kb_graph_edges";
--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_graph_edges" ON "kb_graph_edges"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.kb_unit_embeddings') IS NOT NULL THEN
    ALTER TABLE public.kb_unit_embeddings ADD COLUMN IF NOT EXISTS tenant_id text DEFAULT 'default' NOT NULL;
    CREATE INDEX IF NOT EXISTS kb_unit_embeddings_tenant_id_idx ON public.kb_unit_embeddings (tenant_id);
    ALTER TABLE public.kb_unit_embeddings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.kb_unit_embeddings FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_kb_unit_embeddings ON public.kb_unit_embeddings;
    CREATE POLICY tenant_isolation_kb_unit_embeddings ON public.kb_unit_embeddings
      USING (tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
      WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
  END IF;
END $$;
