-- Apply as the metadata owner before enabling worker cachePolicy.
-- Grant SELECT, INSERT, UPDATE to the same runtime role as agor_workspace_authority.
CREATE TABLE IF NOT EXISTS agor_workspace_inventory (
  tenant_id text NOT NULL,
  worker_id text NOT NULL,
  inventory jsonb NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, worker_id)
);
ALTER TABLE agor_workspace_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE agor_workspace_inventory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_inventory_tenant ON agor_workspace_inventory;
CREATE POLICY workspace_inventory_tenant ON agor_workspace_inventory
 USING (tenant_id = current_setting('agor.workspace_tenant', true))
 WITH CHECK (tenant_id = current_setting('agor.workspace_tenant', true));
CREATE INDEX IF NOT EXISTS workspace_inventory_seen ON agor_workspace_inventory(seen_at);
