SET LOCAL lock_timeout = '3s';

ALTER TABLE "sessions" ADD COLUMN "sdk_home_scope" text DEFAULT 'execution_home' NOT NULL;

SET LOCAL lock_timeout = DEFAULT;
