-- Execution-home keys route delegated execution and credentials, so two users
-- must never share one. NULL remains available for users without a delegated
-- execution home.
CREATE UNIQUE INDEX `users_unix_username_unique` ON `users` (`unix_username`);--> statement-breakpoint
CREATE TABLE `user_external_identities` (
	`identity_key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`name` text,
	`last_login_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_external_identities_provider_subject_unique`
	ON `user_external_identities` (`provider`, `issuer`, `subject`);--> statement-breakpoint
CREATE INDEX `user_external_identities_user_idx`
	ON `user_external_identities` (`user_id`);--> statement-breakpoint
-- Backfill the compatibility JSON projection. Conflicting legacy bindings fail
-- the migration instead of letting a login select an arbitrary user.
INSERT INTO `user_external_identities` (
	`identity_key`, `user_id`, `provider`, `issuer`, `subject`, `email`, `name`,
	`last_login_at`, `created_at`, `updated_at`
)
SELECT
	json_extract(identity.value, '$.key'),
	u.`user_id`,
	json_extract(identity.value, '$.provider'),
	json_extract(identity.value, '$.issuer'),
	json_extract(identity.value, '$.subject'),
	json_extract(identity.value, '$.email'),
	json_extract(identity.value, '$.name'),
	COALESCE(
		CAST(strftime('%s', json_extract(identity.value, '$.last_login_at')) AS integer) * 1000,
		u.`updated_at`,
		u.`created_at`
	),
	u.`created_at`,
	COALESCE(u.`updated_at`, u.`created_at`)
FROM `users` u
JOIN json_each(
	CASE
		WHEN json_valid(u.`data`) AND json_type(u.`data`, '$.external_identities') = 'array'
		THEN json_extract(u.`data`, '$.external_identities')
		ELSE '[]'
	END
) identity
WHERE json_extract(identity.value, '$.key') IS NOT NULL
	AND json_extract(identity.value, '$.provider') IS NOT NULL
	AND json_extract(identity.value, '$.issuer') IS NOT NULL
	AND json_extract(identity.value, '$.subject') IS NOT NULL;
