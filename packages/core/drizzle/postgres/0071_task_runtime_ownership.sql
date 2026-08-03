ALTER TABLE "tasks" ADD COLUMN "runtime_owner_daemon_id" varchar(36);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "runtime_owner_fence" varchar(36);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "runtime_lease_expires_at" timestamp with time zone;
