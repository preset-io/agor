-- Run once as the metadata database owner. The worker role must be NOSUPERUSER
-- NOBYPASSRLS and receive only SELECT/INSERT/UPDATE on this table.
CREATE TABLE IF NOT EXISTS agor_workspace_authority (
  tenant_id text NOT NULL,
  branch_id text NOT NULL,
  slot text NOT NULL,
  state jsonb,
  PRIMARY KEY (tenant_id, branch_id, slot)
);
ALTER TABLE agor_workspace_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE agor_workspace_authority FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_tenant ON agor_workspace_authority
  USING (tenant_id = current_setting('agor.workspace_tenant', true))
  WITH CHECK (tenant_id = current_setting('agor.workspace_tenant', true));
