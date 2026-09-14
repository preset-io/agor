CREATE INDEX "branches_deletion_discovery_idx" ON "branches" ("tenant_id", "branch_id") WHERE "deletion_status" = 'deleting';
--> statement-breakpoint
CREATE POLICY "branch_maintenance_discovery" ON "branches" FOR SELECT USING (
  "deletion_status" = 'deleting'
  AND current_setting('agor.system_scope', true) = 'branch_maintenance_discovery'
);
