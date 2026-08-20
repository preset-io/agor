ALTER TABLE `gateway_channels` ADD COLUMN `webhook_endpoint_id` text;
UPDATE `gateway_channels` SET `webhook_endpoint_id` = lower(hex(randomblob(32))) WHERE `webhook_endpoint_id` IS NULL;
CREATE UNIQUE INDEX `idx_gateway_webhook_endpoint` ON `gateway_channels` (`webhook_endpoint_id`);
