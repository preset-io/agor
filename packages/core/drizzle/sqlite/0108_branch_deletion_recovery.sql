CREATE INDEX "branches_deletion_discovery_idx" ON "branches" ("branch_id") WHERE "deletion_status" = 'deleting';
