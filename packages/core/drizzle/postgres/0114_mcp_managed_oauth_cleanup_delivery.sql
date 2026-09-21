-- Nonportable delivery bindings only. Provider dispatch remains owned by Cloud.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE public.mcp_managed_oauth_outbox ADD COLUMN cleanup_authorization_id text;
--> statement-breakpoint
ALTER TABLE public.mcp_managed_oauth_outbox ADD COLUMN cleanup_operation_id text;
--> statement-breakpoint
ALTER TABLE public.mcp_managed_oauth_outbox ADD CONSTRAINT mcp_managed_cleanup_delivery_pair CHECK (
  (cleanup_authorization_id IS NULL AND cleanup_operation_id IS NULL) OR
  (kind='close' AND cleanup_authorization_id IS NOT NULL AND cleanup_operation_id IS NOT NULL
   AND cleanup_authorization_id ~ '^[A-Za-z0-9_-]{1,128}$'
   AND cleanup_operation_id ~ '^[A-Za-z0-9_-]{1,128}$' AND cleanup_operation_id<>operation_id)
);
