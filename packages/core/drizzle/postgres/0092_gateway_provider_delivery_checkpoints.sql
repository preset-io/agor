SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "gateway_provider_actions" ADD COLUMN "execution_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "gateway_provider_actions" ADD CONSTRAINT "gateway_provider_actions_execution_bounds" CHECK ("execution_metadata" IS NULL OR ("kind" = 'deliver_message' AND octet_length("execution_metadata"::text) <= 4096));
