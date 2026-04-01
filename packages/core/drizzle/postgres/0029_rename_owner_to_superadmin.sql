-- Rename 'owner' role to 'superadmin'
-- This is a data migration: update role values in users table.
-- The app layer handles backwards compat for any rows that still say 'owner'.

UPDATE users
SET role = 'superadmin'
WHERE role = 'owner';
