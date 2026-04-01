-- Rename 'owner' role to 'superadmin'
-- This is a data migration: SQLite text columns have no enum constraint,
-- so we just update the values. The app layer handles backwards compat
-- for any rows that still say 'owner' (normalizeRole in types/user.ts).

UPDATE users
SET role = 'superadmin'
WHERE role = 'owner';
