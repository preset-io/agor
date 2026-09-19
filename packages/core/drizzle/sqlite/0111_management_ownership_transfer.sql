-- Transfer authorization and recipient validation belong to the shared
-- application command. Ordinary repository/policy updates still reject owner
-- changes. Preserve the existing insert/existence and user-deletion guards.
DROP TRIGGER `boards_primary_owner_immutable`;
--> statement-breakpoint
DROP TRIGGER `branches_primary_owner_immutable`;
