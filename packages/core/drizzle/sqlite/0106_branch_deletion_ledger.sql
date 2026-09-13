-- Additive checkpoint storage only; does not enable branch deletion or acquire maintenance ownership.
CREATE TABLE "branch_deletion_operations" (
  "operation_id" text PRIMARY KEY NOT NULL,
  "branch_id" text NOT NULL,
  "requested_by" text NOT NULL,
  "confirmed_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  "completed_at" integer,
  "status" text NOT NULL,
  "stage" text NOT NULL,
  "error_code" text,
  "revision" integer DEFAULT 0 NOT NULL,
  "inventory_sealed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_deletion_operations_branch_unique" ON "branch_deletion_operations" ("branch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_deletion_operations_tenant_operation_unique" ON "branch_deletion_operations" ("operation_id");
--> statement-breakpoint
CREATE INDEX "branch_deletion_operations_pending_idx" ON "branch_deletion_operations" ("status", "operation_id");
--> statement-breakpoint
CREATE TABLE "branch_deletion_resources" (
  "operation_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "kind" text NOT NULL,
  "owner" text NOT NULL,
  "locator" text NOT NULL,
  "version" text NOT NULL,
  "state" text NOT NULL,
  "invocation_id" text,
  "retention_reason" text,
  PRIMARY KEY ("operation_id", "resource_id"),
  CONSTRAINT "branch_deletion_resources_operation_fk" FOREIGN KEY ("operation_id")
    REFERENCES "branch_deletion_operations" ("operation_id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX "branch_deletion_resources_pending_idx" ON "branch_deletion_resources" ("operation_id", "state", "resource_id");
