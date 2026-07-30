CREATE TABLE `kb_document_comments` (
	`comment_id` text(36) PRIMARY KEY NOT NULL,
	`document_id` text(36) NOT NULL,
	`created_by` text(36) NOT NULL,
	`content` text NOT NULL,
	`content_preview` text NOT NULL,
	`parent_comment_id` text(36),
	`anchor_slug` text,
	`anchor_label` text,
	`resolved` integer DEFAULT false NOT NULL,
	`edited` integer DEFAULT false NOT NULL,
	`reactions` text DEFAULT '[]' NOT NULL,
	`mentions` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `kb_documents`(`document_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `kb_document_comments_document_idx` ON `kb_document_comments` (`document_id`);--> statement-breakpoint
CREATE INDEX `kb_document_comments_document_anchor_idx` ON `kb_document_comments` (`document_id`,`anchor_slug`);--> statement-breakpoint
CREATE INDEX `kb_document_comments_parent_idx` ON `kb_document_comments` (`parent_comment_id`);--> statement-breakpoint
CREATE INDEX `kb_document_comments_created_by_idx` ON `kb_document_comments` (`created_by`);--> statement-breakpoint
CREATE INDEX `kb_document_comments_created_idx` ON `kb_document_comments` (`created_at`);--> statement-breakpoint
CREATE INDEX `kb_document_comments_resolved_idx` ON `kb_document_comments` (`resolved`);
