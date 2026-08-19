-- Narrow Discord activity actions share the tenant-owned provider outbox.
-- They contain canonical refs plus sanitized state only. Display work expires
-- by DB time; terminal cleanup is deliberately non-expiring.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "gateway_provider_actions"
  ADD COLUMN "drop_after" timestamp with time zone;
--> statement-breakpoint
UPDATE "gateway_provider_actions"
SET "result_metadata" = jsonb_set("result_metadata", '{kind}', '"deliver_message"'::jsonb, true)
WHERE "result_metadata" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "gateway_provider_actions"
  DROP CONSTRAINT "gateway_provider_actions_kind_check";
--> statement-breakpoint
ALTER TABLE "gateway_provider_actions"
  ADD CONSTRAINT "gateway_provider_actions_kind_check"
  CHECK ("kind" IN ('deliver_message', 'discord_progress'));
--> statement-breakpoint
ALTER TABLE "gateway_provider_actions"
  ADD CONSTRAINT "gateway_provider_actions_shape_check"
  CHECK (
    ("kind" = 'deliver_message' AND "message_id" IS NOT NULL AND "drop_after" IS NULL)
    OR
    ("kind" = 'discord_progress' AND "message_id" IS NULL AND (
      (("params"->>'state') = 'done' AND "drop_after" IS NULL)
      OR (("params"->>'state') <> 'done' AND "drop_after" IS NOT NULL)
    ))
  );
--> statement-breakpoint
CREATE INDEX "gateway_provider_actions_activity_expiry_idx"
  ON "gateway_provider_actions" ("tenant_id", "gateway_channel_id", "kind", "drop_after", "status");
