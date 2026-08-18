-- Snapshot the teammate display name so authorship remains readable after rename/deletion.
ALTER TABLE "kb_documents" ADD COLUMN "updated_by_teammate_name" text;--> statement-breakpoint
ALTER TABLE "kb_document_versions" ADD COLUMN "created_by_teammate_name" text;
