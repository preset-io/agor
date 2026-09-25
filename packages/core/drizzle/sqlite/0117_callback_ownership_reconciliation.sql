-- Main and the withdrawn callback draft both used watermark 1789344000005.
-- Reconcile either history after the draft retirement watermark (0006),
-- preserving stored rows, tenant isolation, and management transfer support.
CREATE TABLE IF NOT EXISTS `completion_subscriptions` (
	`subscription_id` text(36) PRIMARY KEY NOT NULL,
	`propagation_mode` text DEFAULT 'root' NOT NULL,
	`join_policy` text DEFAULT 'designated_child' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`requested_by_user_id` text(36) NOT NULL,
	`origin_session_id` text(36) NOT NULL,
	`origin_task_id` text(36) NOT NULL,
	`callback_session_id` text(36),
	`root_session_id` text(36),
	`root_task_id` text(36),
	`active_session_id` text(36),
	`active_task_id` text(36),
	`path` text NOT NULL,
	`max_depth` integer DEFAULT 8 NOT NULL,
	`terminal_status` text,
	`terminal_snapshot` text,
	`delivery_task_id` text(36),
	`delivery_attempt_count` integer DEFAULT 0 NOT NULL,
	`next_delivery_at` integer,
	`last_delivery_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delegated_at` integer,
	`terminal_at` integer,
	`delivered_at` integer,
	FOREIGN KEY (`callback_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`root_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`root_task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`delivery_task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `completion_subscriptions_root_task_unique` ON `completion_subscriptions` (`root_task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `completion_subscriptions_active_task_idx` ON `completion_subscriptions` (`active_task_id`,`state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `completion_subscriptions_callback_idx` ON `completion_subscriptions` (`callback_session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `completion_subscriptions_delivery_due_idx` ON `completion_subscriptions` (`state`,`next_delivery_at`,`subscription_id`);

--> statement-breakpoint
-- Transfer authorization and recipient validation belong to the shared
-- application command. Ordinary repository/policy updates still reject owner
-- changes. Preserve the existing insert/existence and user-deletion guards.
DROP TRIGGER IF EXISTS `boards_primary_owner_immutable`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `branches_primary_owner_immutable`;

--> statement-breakpoint
-- Draft retirement/reconciliation watermarks (0006/0007) could skip main's
-- KB receipts migration (0006). Reconcile it without replacing existing rows.
CREATE TABLE IF NOT EXISTS "kb_import_receipts" (
 "receipt_id" text PRIMARY KEY NOT NULL,
 "owner_user_id" text NOT NULL,
 "bundle" text NOT NULL,
 "slug" text NOT NULL,
 "entry_key" text NOT NULL,
 "target_id" text NOT NULL,
 "digest" text NOT NULL,
 "request_bytes" integer DEFAULT 0 NOT NULL,
 "reconciled_count" integer DEFAULT -1 NOT NULL,
 "created_at" integer NOT NULL,
 CONSTRAINT "kb_import_receipts_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("user_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kb_import_receipts_identity_unique" ON "kb_import_receipts" ("owner_user_id", "bundle", "slug", "entry_key");

--> statement-breakpoint
-- 7475feacb used 1790129000214, skipping main's source column at ...212.
-- SQLite's migrator guards this ADD against an existing or earlier-batched
-- column; SQLite itself has no ADD COLUMN IF NOT EXISTS syntax.
-- agor:sqlite-add-user-api-key-source-if-missing
ALTER TABLE `user_api_keys` ADD COLUMN `source` text DEFAULT 'manual' NOT NULL;
