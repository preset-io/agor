-- SQLite keeps schema parity for portability and standalone upgrades. Semantic
-- vector indexing remains PostgreSQL-only, so these coordination fields stay
-- unused in standalone mode.
ALTER TABLE `kb_document_units` ADD `embedding_claim_token` text;
--> statement-breakpoint
ALTER TABLE `kb_document_units` ADD `embedding_claim_generation` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `kb_document_units` ADD `embedding_claimed_at` integer;
--> statement-breakpoint
ALTER TABLE `kb_document_units` ADD `embedding_claim_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `kb_document_units` ADD `embedding_claim_instance_id` text;
--> statement-breakpoint
ALTER TABLE `kb_document_units` ADD `embedding_claim_boot_id` text;
--> statement-breakpoint
ALTER TABLE `kb_document_units` ADD `embedding_failure_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `kb_document_units` ADD `embedding_retry_at` integer;
--> statement-breakpoint
UPDATE `kb_document_units`
SET `embedding_status` = 'not_configured',
    `embedding_error` = NULL,
    `updated_at` = CAST(strftime('%s', 'now') AS integer) * 1000
WHERE `embedding_status` IN ('pending', 'stale', 'error')
  AND NOT EXISTS (
    SELECT 1
    FROM `kb_documents` AS d
    JOIN `kb_namespaces` AS n ON n.`namespace_id` = d.`namespace_id`
    WHERE d.`document_id` = `kb_document_units`.`document_id`
      AND d.`current_version_id` = `kb_document_units`.`version_id`
      AND d.`archived` = 0
      AND n.`archived` = 0
  );
--> statement-breakpoint
CREATE INDEX `kb_document_units_embedding_work_scan_idx`
  ON `kb_document_units` (
    `created_at`,
    `unit_id`
  )
  WHERE `content_text` IS NOT NULL
    AND `embedding_status` IN ('pending', 'stale', 'error');
