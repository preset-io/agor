ALTER TABLE "tasks" ADD COLUMN "executor_connected_at" timestamp with time zone;--> statement-breakpoint
UPDATE "tasks" SET "queue_position" = NULL WHERE "status" <> 'queued';
