ALTER TABLE "tasks" ALTER COLUMN "last_executor_heartbeat_at" TYPE timestamp with time zone USING "last_executor_heartbeat_at" AT TIME ZONE 'UTC';
