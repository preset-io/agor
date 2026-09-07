SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DROP INDEX "branches_environment_health_discovery_idx";
--> statement-breakpoint
CREATE INDEX "branches_environment_health_discovery_idx" ON "branches" ("tenant_id", "branch_id")
  WHERE "archived" = false
    AND ("data"->'environment_instance'->>'status') IN ('starting', 'running', 'stopping');
--> statement-breakpoint
ALTER POLICY "environment_health_discovery" ON "branches"
  USING (
    "archived" = false
    AND ("data"->'environment_instance'->>'status') IN ('starting', 'running', 'stopping')
    AND current_setting('agor.system_scope', true) = 'environment_health_discovery'
  );
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
