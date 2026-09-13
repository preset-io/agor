-- Additive checkpoint storage only; does not enable branch deletion or acquire maintenance ownership.
CREATE TABLE "branch_deletion_operations" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "branch_id" text NOT NULL,
  "requested_by" text NOT NULL,
  "confirmed_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "status" text NOT NULL,
  "stage" text NOT NULL,
  "error_code" text,
  "revision" integer DEFAULT 0 NOT NULL,
  "inventory_sealed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_deletion_operations_branch_unique" ON "branch_deletion_operations" ("tenant_id", "branch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_deletion_operations_tenant_operation_unique" ON "branch_deletion_operations" ("tenant_id", "operation_id");
--> statement-breakpoint
CREATE INDEX "branch_deletion_operations_pending_idx" ON "branch_deletion_operations" ("tenant_id", "status", "operation_id");
--> statement-breakpoint
CREATE TABLE "branch_deletion_resources" (
  "tenant_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "kind" text NOT NULL,
  "owner" text NOT NULL,
  "locator" text NOT NULL,
  "version" text NOT NULL,
  "state" text NOT NULL,
  "invocation_id" text,
  "retention_reason" text,
  PRIMARY KEY ("tenant_id", "operation_id", "resource_id"),
  CONSTRAINT "branch_deletion_resources_operation_fk" FOREIGN KEY ("tenant_id", "operation_id")
    REFERENCES "branch_deletion_operations" ("tenant_id", "operation_id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "branch_deletion_resources_pending_idx" ON "branch_deletion_resources" ("tenant_id", "operation_id", "state", "resource_id");
--> statement-breakpoint
ALTER TABLE "branch_deletion_operations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_deletion_operations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branch_deletion_operations" ON "branch_deletion_operations"
  USING ("tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
  WITH CHECK ("tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
--> statement-breakpoint
ALTER TABLE "branch_deletion_resources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_deletion_resources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branch_deletion_resources" ON "branch_deletion_resources"
  USING ("tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''))
  WITH CHECK ("tenant_id" = NULLIF(current_setting('agor.tenant_id', true), ''));
