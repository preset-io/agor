-- Per-user sandbox home overlay SOURCE. Absolute host path bound over the
-- passwd home under unix_user_mode: sandbox (sandbox.home_mode: per_user).
-- Nullable: null → canonical store <data_home>/tenants/<tenant>/homes/<user_id>.
ALTER TABLE `users` ADD COLUMN `filesystem_home` text;
