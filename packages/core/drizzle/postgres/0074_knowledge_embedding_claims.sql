-- Durable Knowledge embedding ownership. Provider calls run after this short
-- claim transaction, so expiry uses database time and token+generation fence
-- any worker that returns after reclaim or materialization invalidation.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD COLUMN "embedding_claim_token" text;
--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD COLUMN "embedding_claim_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD COLUMN "embedding_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD COLUMN "embedding_claim_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD COLUMN "embedding_claim_instance_id" text;
--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD COLUMN "embedding_claim_boot_id" text;
--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD COLUMN "embedding_failure_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "kb_document_units" ADD COLUMN "embedding_retry_at" timestamp with time zone;
--> statement-breakpoint

-- Historical and archived chunks are not provider work. Older code left some
-- of them pending, which could otherwise consume every bounded discovery page.
UPDATE "kb_document_units" AS u
SET "embedding_status" = 'not_configured',
    "embedding_error" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
WHERE u."embedding_status" IN ('pending', 'stale', 'error')
  AND NOT EXISTS (
    SELECT 1
    FROM "kb_documents" AS d
    JOIN "kb_namespaces" AS n ON n."namespace_id" = d."namespace_id"
    WHERE d."document_id" = u."document_id"
      AND d."current_version_id" = u."version_id"
      AND d."archived" = false
      AND n."archived" = false
  );
--> statement-breakpoint

CREATE INDEX "kb_document_units_embedding_work_scan_idx"
  ON "kb_document_units" (
    "tenant_id",
    "embedding_retry_at",
    "embedding_claim_expires_at",
    "created_at",
    "unit_id"
  )
  WHERE "content_text" IS NOT NULL
    AND "embedding_status" IN ('pending', 'stale', 'error');
--> statement-breakpoint

-- System scope is routing-only: every daemon may discover bounded unit/tenant
-- refs, but claims and every later mutation re-enter the discovered tenant RLS
-- scope. No provider input or credential is exposed by this capability.
DROP POLICY IF EXISTS "knowledge_embedding_discovery" ON "kb_document_units";
--> statement-breakpoint
CREATE POLICY "knowledge_embedding_discovery" ON "kb_document_units"
  FOR SELECT
  USING (
    current_setting('agor.system_scope', true) = 'knowledge_embedding_discovery'
    AND "content_text" IS NOT NULL
    AND "embedding_status" IN ('pending', 'stale', 'error')
  );
