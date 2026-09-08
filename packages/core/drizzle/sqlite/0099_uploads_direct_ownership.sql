CREATE TABLE `__new_uploads` (
	`upload_ref` text PRIMARY KEY NOT NULL,
	`created_by` text(36) NOT NULL,
	`session_id` text(36) NOT NULL,
	`agent_id` text(36),
	`storage_key` text NOT NULL,
	`original_name` text NOT NULL,
	`display_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum` text,
	`status` text DEFAULT 'active' NOT NULL,
	`provenance` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer
);--> statement-breakpoint
INSERT INTO `__new_uploads` (
	`upload_ref`, `created_by`, `session_id`, `agent_id`, `storage_key`,
	`original_name`, `display_name`, `content_type`, `size_bytes`, `checksum`,
	`status`, `provenance`, `created_at`, `expires_at`
) SELECT
	u.`upload_ref`, u.`created_by`, u.`session_id`, s.`agent_id`, u.`storage_key`,
	u.`original_name`, u.`display_name`, u.`content_type`, u.`size_bytes`, u.`checksum`,
	u.`status`, u.`provenance`, u.`created_at`, u.`expires_at`
FROM `uploads` u
LEFT JOIN `sessions` s ON s.`session_id` = u.`session_id`;--> statement-breakpoint
DROP TABLE `uploads`;--> statement-breakpoint
ALTER TABLE `__new_uploads` RENAME TO `uploads`;--> statement-breakpoint
CREATE INDEX `uploads_owner_idx` ON `uploads` (`created_by`);--> statement-breakpoint
CREATE INDEX `uploads_session_idx` ON `uploads` (`session_id`);--> statement-breakpoint
CREATE INDEX `uploads_expiry_idx` ON `uploads` (`expires_at`);
