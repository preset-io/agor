SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER POLICY "branch_maintenance_discovery" ON "branches" USING (
  current_setting('agor.system_scope', true) = 'branch_maintenance_discovery'
  AND (
    "deletion_status" = 'deleting'
    OR (
      "deletion_status" = 'deletion_failed'
      AND "data" -> 'maintenance' ->> 'kind' = 'delete'
      AND "data" -> 'maintenance' ->> 'execution_id' IS NOT NULL
      AND "data" -> 'maintenance' ->> 'execution_process' IS NOT NULL
    )
  )
);
--> statement-breakpoint
CREATE INDEX "branches_deletion_process_discovery_idx" ON "branches" ("tenant_id", "branch_id") WHERE
  "deletion_status" IN ('deleting', 'deletion_failed')
  AND "data" -> 'maintenance' ->> 'kind' = 'delete'
  AND "data" -> 'maintenance' ->> 'execution_id' IS NOT NULL
  AND "data" -> 'maintenance' ->> 'execution_process' IS NOT NULL;
