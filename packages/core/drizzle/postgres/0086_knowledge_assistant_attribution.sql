-- Additive, nullable attribution keeps existing versions and supports rolling rollback.
-- Session IDs intentionally are not foreign keys: immutable authorship survives Session deletion.
-- Existing tenant RLS policies cover the new columns; no cross-tenant relation is introduced.
ALTER TABLE "kb_documents" ADD COLUMN "updated_by_session_id" varchar(36);--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "updated_by_agentic_tool" text;--> statement-breakpoint
ALTER TABLE "kb_document_versions" ADD COLUMN "created_by_session_id" varchar(36);--> statement-breakpoint
ALTER TABLE "kb_document_versions" ADD COLUMN "created_by_agentic_tool" text;
