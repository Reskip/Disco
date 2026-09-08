-- SQLite cannot drop a NOT NULL constraint in place. Rebuild branches so
-- directory-mode Disco workspaces can be repository-free in every supported
-- database, not only PostgreSQL.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_branches` (
	`branch_id` text(36) PRIMARY KEY NOT NULL,
	`repo_id` text(36),
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`created_by` text NOT NULL DEFAULT 'anonymous',
	`name` text NOT NULL,
	`ref` text NOT NULL,
	`ref_type` text,
	`branch_unique_id` integer NOT NULL,
	`start_command` text,
	`stop_command` text,
	`nuke_command` text,
	`health_check_url` text,
	`app_url` text,
	`logs_command` text,
	`environment_variant` text,
	`environment_generation` integer DEFAULT 0 NOT NULL,
	`environment_health_claim_token` text,
	`environment_health_claimed_at` integer,
	`environment_health_claim_expires_at` integer,
	`environment_health_next_observation_at` integer,
	`environment_health_claim_instance_id` text,
	`environment_health_claim_boot_id` text,
	`environment_health_claim_generation` integer DEFAULT 0 NOT NULL,
	`board_id` text(36),
	`needs_attention` integer DEFAULT true NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`archived_by` text(36),
	`filesystem_status` text,
	`permission_source` text DEFAULT 'override' NOT NULL,
	`others_can` text DEFAULT 'view' CHECK(`others_can` IN ('none', 'view', 'session', 'prompt', 'all')),
	`unix_group` text,
	`others_fs_access` text DEFAULT 'read' CHECK(`others_fs_access` IN ('none', 'read', 'write')),
	`storage_mode` text DEFAULT 'worktree' NOT NULL,
	`clone_depth` integer,
	`data` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`repo_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_branches` (
	`branch_id`, `repo_id`, `created_at`, `updated_at`, `created_by`, `name`, `ref`,
	`ref_type`, `branch_unique_id`, `start_command`, `stop_command`, `nuke_command`,
	`health_check_url`, `app_url`, `logs_command`, `environment_variant`,
	`environment_generation`, `environment_health_claim_token`,
	`environment_health_claimed_at`, `environment_health_claim_expires_at`,
	`environment_health_next_observation_at`, `environment_health_claim_instance_id`,
	`environment_health_claim_boot_id`, `environment_health_claim_generation`,
	`board_id`, `needs_attention`, `archived`, `archived_at`, `archived_by`,
	`filesystem_status`, `permission_source`, `others_can`, `unix_group`,
	`others_fs_access`, `storage_mode`, `clone_depth`, `data`
)
SELECT
	`branch_id`, `repo_id`, `created_at`, `updated_at`, `created_by`, `name`, `ref`,
	`ref_type`, `branch_unique_id`, `start_command`, `stop_command`, `nuke_command`,
	`health_check_url`, `app_url`, `logs_command`, `environment_variant`,
	`environment_generation`, `environment_health_claim_token`,
	`environment_health_claimed_at`, `environment_health_claim_expires_at`,
	`environment_health_next_observation_at`, `environment_health_claim_instance_id`,
	`environment_health_claim_boot_id`, `environment_health_claim_generation`,
	`board_id`, `needs_attention`, `archived`, `archived_at`, `archived_by`,
	`filesystem_status`, `permission_source`, `others_can`, `unix_group`,
	`others_fs_access`, `storage_mode`, `clone_depth`, `data`
FROM `branches`;--> statement-breakpoint
DROP TABLE `branches`;--> statement-breakpoint
ALTER TABLE `__new_branches` RENAME TO `branches`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint

CREATE INDEX `branches_repo_idx` ON `branches` (`repo_id`);--> statement-breakpoint
CREATE INDEX `branches_name_idx` ON `branches` (`name`);--> statement-breakpoint
CREATE INDEX `branches_ref_idx` ON `branches` (`ref`);--> statement-breakpoint
CREATE INDEX `branches_board_idx` ON `branches` (`board_id`);--> statement-breakpoint
CREATE INDEX `branches_created_idx` ON `branches` (`created_at`);--> statement-breakpoint
CREATE INDEX `branches_updated_idx` ON `branches` (`updated_at`);--> statement-breakpoint
CREATE INDEX `branches_repo_name_unique` ON `branches` (`repo_id`, `name`);--> statement-breakpoint
CREATE INDEX `branches_environment_health_lease_idx` ON `branches` (`archived`, `environment_health_claim_expires_at`, `branch_id`);--> statement-breakpoint

UPDATE `branches`
SET `repo_id` = NULL
WHERE `storage_mode` = 'directory';--> statement-breakpoint

CREATE UNIQUE INDEX `branches_directory_owner_name_unique`
ON `branches` (`created_by`, `name`)
WHERE `repo_id` IS NULL AND `storage_mode` = 'directory' AND `archived` = 0;--> statement-breakpoint

DELETE FROM `repos`
WHERE `slug` = 'disco/workspaces'
  AND NOT EXISTS (SELECT 1 FROM `branches` WHERE `branches`.`repo_id` = `repos`.`repo_id`);
