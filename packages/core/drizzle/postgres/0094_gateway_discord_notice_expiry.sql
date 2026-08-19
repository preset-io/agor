SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "gateway_provider_actions" DROP CONSTRAINT "gateway_provider_actions_shape_check";--> statement-breakpoint
UPDATE "gateway_provider_actions"
SET "drop_after" = "created_at" + interval '2 minutes'
WHERE "kind" = 'discord_notice' AND "drop_after" IS NULL;--> statement-breakpoint
ALTER TABLE "gateway_provider_actions" ADD CONSTRAINT "gateway_provider_actions_shape_check" CHECK (("kind" = 'deliver_message' AND "message_id" IS NOT NULL AND "drop_after" IS NULL) OR ("kind" = 'discord_progress' AND "message_id" IS NULL AND ((("params"->>'state') = 'done' AND "drop_after" IS NULL) OR (("params"->>'state') <> 'done' AND "drop_after" IS NOT NULL))) OR ("kind" = 'discord_notice' AND "message_id" IS NULL AND "thread_session_map_id" IS NULL AND "session_id" IS NULL AND "task_id" IS NULL AND ("gateway_inbound_event_id" IS NOT NULL OR "status" IN ('completed', 'dead_letter', 'canceled')) AND "drop_after" IS NOT NULL));
