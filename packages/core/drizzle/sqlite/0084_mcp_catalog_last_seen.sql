-- When a registry walk last returned this server. Stamped on every observation,
-- including the unchanged fast path, so a later staleness sweep can reconcile a
-- hard deletion — which leaves nothing behind for a walk to notice.
--
-- Added now rather than alongside that sweep: introduced later, every existing
-- row is NULL and cannot be told apart from a server the registry has dropped.
ALTER TABLE `mcp_catalog_entries` ADD `last_registry_seen_at` integer;
--> statement-breakpoint
CREATE INDEX `mcp_catalog_entries_last_registry_seen_at_idx`
  ON `mcp_catalog_entries` (`last_registry_seen_at`);
