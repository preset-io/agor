ALTER TABLE "gateway_channels" ADD COLUMN "webhook_endpoint_id" text;
UPDATE "gateway_channels" SET "webhook_endpoint_id" = md5(random()::text || clock_timestamp()::text || id) || md5(id || random()::text) WHERE "webhook_endpoint_id" IS NULL;
ALTER TABLE "gateway_channels" ALTER COLUMN "webhook_endpoint_id" SET NOT NULL;
CREATE UNIQUE INDEX "gateway_channels_webhook_endpoint_unique" ON "gateway_channels" ("webhook_endpoint_id");
CREATE POLICY "gateway_webhook_endpoint_discovery" ON "gateway_channels" FOR SELECT USING (
  "channel_type" = 'webhook' AND current_setting('agor.system_scope', true) = 'gateway_webhook_endpoint_discovery'
);
