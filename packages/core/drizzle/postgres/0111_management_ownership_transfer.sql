-- Bound table-lock acquisition; a busy migration rolls back rather than
-- stalling normal traffic indefinitely. No owner rows or authorship are changed.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DROP TRIGGER boards_primary_owner_immutable ON boards;
--> statement-breakpoint
DROP TRIGGER branches_primary_owner_immutable ON branches;
--> statement-breakpoint
DROP FUNCTION agor_reject_primary_owner_change();
-- Tenant-qualified owner FKs, NOT NULL constraints and FORCE RLS remain intact.
-- Authorization/eligibility is enforced by the shared application command.
