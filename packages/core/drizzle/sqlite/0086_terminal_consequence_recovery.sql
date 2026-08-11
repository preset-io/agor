-- Existing terminal Tasks predate durable consequence completion tracking.
-- Baseline them once so startup does not replay every historical callback or gateway delivery.
UPDATE `tasks`
SET `data` = json_set(
  COALESCE(`data`, '{}'),
  '$.metadata.terminal_consequences_completed_at',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
WHERE `status` IN ('completed', 'failed', 'stopped', 'timed_out')
  AND json_extract(`data`, '$.metadata.terminal_consequences_completed_at') IS NULL;
