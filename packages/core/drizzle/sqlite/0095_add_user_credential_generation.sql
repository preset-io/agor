-- Monotonic local-credential generation used to invalidate browser tokens
-- without depending on wall-clock ordering. Existing users begin at zero.
ALTER TABLE `users` ADD `credential_generation` integer DEFAULT 0 NOT NULL;
