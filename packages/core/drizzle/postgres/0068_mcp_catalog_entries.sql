-- The MCP catalog mirrors a public, unauthenticated registry and joins a
-- curated overlay checked into this repository onto it. It holds no tenant
-- data and is the only table without a `tenant_id` column, so it carries no
-- `tenant_isolation_*` policy.
--
-- RLS is still enabled, for a different reason: reads must be open to every
-- tenant while writes must be impossible from a tenant-scoped request path.
-- Ingestion and curation seeding therefore run under the narrow
-- `mcp_catalog_ingestion` system capability, which the daemon sets
-- transaction-locally via runWithSystemDatabaseScope().

CREATE TABLE "mcp_catalog_entries" (
	"catalog_entry_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"version" text,
	"registry_updated_at" timestamp with time zone,
	"title" text,
	"description" text,
	"website_url" text,
	"repository_url" text,
	"transport" text,
	"remote_url" text,
	"has_remote" boolean DEFAULT false NOT NULL,
	"has_package" boolean DEFAULT false NOT NULL,
	"curated" boolean DEFAULT false NOT NULL,
	"category" text,
	"capability_tags" text,
	"benefit" text,
	"starter_prompt" text,
	"permission_disclosure" text,
	"icon_url" text,
	"verified" boolean DEFAULT false NOT NULL,
	"popularity_rank" integer,
	"connect_count" integer DEFAULT 0 NOT NULL,
	"probed_auth_type" text DEFAULT 'unknown' NOT NULL,
	"probed_at" timestamp with time zone,
	"auth_server_origin" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_catalog_entries_name_unique" ON "mcp_catalog_entries" USING btree ("name");
--> statement-breakpoint
CREATE INDEX "mcp_catalog_entries_category_idx" ON "mcp_catalog_entries" USING btree ("category");
--> statement-breakpoint
CREATE INDEX "mcp_catalog_entries_verified_idx" ON "mcp_catalog_entries" USING btree ("verified");
--> statement-breakpoint
CREATE INDEX "mcp_catalog_entries_curated_idx" ON "mcp_catalog_entries" USING btree ("curated");
--> statement-breakpoint
CREATE INDEX "mcp_catalog_entries_popularity_idx" ON "mcp_catalog_entries" USING btree ("popularity_rank");
--> statement-breakpoint
CREATE INDEX "mcp_catalog_entries_probed_at_idx" ON "mcp_catalog_entries" USING btree ("probed_at");
--> statement-breakpoint
ALTER TABLE "mcp_catalog_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mcp_catalog_entries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_catalog_public_read" ON "mcp_catalog_entries";
--> statement-breakpoint
CREATE POLICY "mcp_catalog_public_read" ON "mcp_catalog_entries"
  FOR SELECT
  USING (true);
--> statement-breakpoint
DROP POLICY IF EXISTS "mcp_catalog_ingestion_write" ON "mcp_catalog_entries";
--> statement-breakpoint
CREATE POLICY "mcp_catalog_ingestion_write" ON "mcp_catalog_entries"
  USING (current_setting('agor.system_scope', true) = 'mcp_catalog_ingestion')
  WITH CHECK (current_setting('agor.system_scope', true) = 'mcp_catalog_ingestion');
