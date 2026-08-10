SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "environment_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "environment_health_claim_token" text;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "environment_health_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "environment_health_claim_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "environment_health_next_observation_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "environment_health_claim_instance_id" text;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "environment_health_claim_boot_id" text;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "environment_health_claim_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX "branches_environment_health_discovery_idx" ON "branches" ("tenant_id","branch_id")
  WHERE "archived" = false
    AND ("data"->'environment_instance'->>'status') IN ('starting', 'running');
--> statement-breakpoint
DROP POLICY IF EXISTS "environment_health_discovery" ON "branches";
--> statement-breakpoint
CREATE POLICY "environment_health_discovery" ON "branches"
  FOR SELECT
  USING (
    "archived" = false
    AND ("data"->'environment_instance'->>'status') IN ('starting', 'running')
    AND current_setting('agor.system_scope', true) = 'environment_health_discovery'
  );
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
