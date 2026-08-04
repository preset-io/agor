CREATE TABLE "kb_document_comments" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"comment_id" varchar(36) PRIMARY KEY NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"created_by" varchar(36) NOT NULL,
	"content" text NOT NULL,
	"content_preview" text NOT NULL,
	"parent_comment_id" varchar(36),
	"anchor_slug" text,
	"anchor_label" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"reactions" jsonb DEFAULT '[]' NOT NULL,
	"mentions" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "kb_document_comments" ADD CONSTRAINT "kb_document_comments_document_id_kb_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_document_comments_tenant_id_idx" ON "kb_document_comments" ("tenant_id");--> statement-breakpoint
CREATE INDEX "kb_document_comments_document_idx" ON "kb_document_comments" ("document_id");--> statement-breakpoint
CREATE INDEX "kb_document_comments_document_anchor_idx" ON "kb_document_comments" ("document_id","anchor_slug");--> statement-breakpoint
CREATE INDEX "kb_document_comments_parent_idx" ON "kb_document_comments" ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "kb_document_comments_created_by_idx" ON "kb_document_comments" ("created_by");--> statement-breakpoint
CREATE INDEX "kb_document_comments_created_idx" ON "kb_document_comments" ("created_at");--> statement-breakpoint
CREATE INDEX "kb_document_comments_resolved_idx" ON "kb_document_comments" ("resolved");--> statement-breakpoint
ALTER TABLE "kb_document_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kb_document_comments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_kb_document_comments" ON "kb_document_comments";--> statement-breakpoint
CREATE POLICY "tenant_isolation_kb_document_comments" ON "kb_document_comments"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
