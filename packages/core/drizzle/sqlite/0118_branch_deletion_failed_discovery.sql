CREATE INDEX "branches_deletion_process_discovery_idx" ON "branches" ("branch_id") WHERE
  "deletion_status" IN ('deleting', 'deletion_failed')
  AND "data" -> 'maintenance' ->> 'kind' = 'delete'
  AND "data" -> 'maintenance' ->> 'execution_id' IS NOT NULL
  AND "data" -> 'maintenance' ->> 'execution_process' IS NOT NULL;
