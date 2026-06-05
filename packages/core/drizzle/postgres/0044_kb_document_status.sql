-- Add Knowledge document lifecycle status. Existing documents are published.
ALTER TABLE "kb_documents" ADD COLUMN "status" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
CREATE INDEX "kb_documents_status_idx" ON "kb_documents" ("status");
