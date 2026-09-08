PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`session_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`created_by` text(36) DEFAULT 'anonymous' NOT NULL,
	`status` text NOT NULL,
	`agentic_tool` text NOT NULL,
	`board_id` text(36),
	`parent_session_id` text(36),
	`forked_from_session_id` text(36),
	`branch_id` text(36),
	`scheduled_run_at` integer,
	`scheduled_from_branch` integer DEFAULT false NOT NULL,
	`ready_for_prompt` integer DEFAULT 0 NOT NULL,
	`data` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_reason` text,
	`unix_username` text,
	`schedule_id` text(36) REFERENCES `schedules`(`schedule_id`) ON DELETE SET NULL,
	`agentic_tool_preset_id` text(36) REFERENCES `agentic_tool_presets`(`preset_id`) ON DELETE restrict,
	`scheduler_init_completed_at` integer,
	`agent_id` text(36) REFERENCES `agents`(`agent_id`) ON DELETE SET NULL,
	`working_directory` text,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`forked_from_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_sessions` (
	`session_id`, `created_at`, `updated_at`, `created_by`, `status`, `agentic_tool`,
	`board_id`, `parent_session_id`, `forked_from_session_id`, `branch_id`,
	`scheduled_run_at`, `scheduled_from_branch`, `ready_for_prompt`, `data`,
	`archived`, `archived_reason`, `unix_username`, `schedule_id`,
	`agentic_tool_preset_id`, `scheduler_init_completed_at`, `agent_id`, `working_directory`
) SELECT
	`session_id`, `created_at`, `updated_at`, `created_by`, `status`, `agentic_tool`,
	`board_id`, `parent_session_id`, `forked_from_session_id`, `branch_id`,
	`scheduled_run_at`, `scheduled_from_branch`, `ready_for_prompt`, `data`,
	`archived`, `archived_reason`, `unix_username`, `schedule_id`,
	`agentic_tool_preset_id`, `scheduler_init_completed_at`, `agent_id`, `working_directory`
FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `sessions_status_ready_idx` ON `sessions` (`status`,`ready_for_prompt`);--> statement-breakpoint
CREATE INDEX `sessions_agentic_tool_idx` ON `sessions` (`agentic_tool`);--> statement-breakpoint
CREATE INDEX `sessions_agentic_tool_preset_idx` ON `sessions` (`agentic_tool_preset_id`);--> statement-breakpoint
CREATE INDEX `sessions_board_idx` ON `sessions` (`board_id`);--> statement-breakpoint
CREATE INDEX `sessions_agent_idx` ON `sessions` (`agent_id`);--> statement-breakpoint
CREATE INDEX `sessions_branch_idx` ON `sessions` (`branch_id`);--> statement-breakpoint
CREATE INDEX `sessions_created_idx` ON `sessions` (`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_parent_idx` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_forked_from_idx` ON `sessions` (`forked_from_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_schedule_run_unique` ON `sessions` (`schedule_id`,`scheduled_run_at`)
	WHERE `schedule_id` IS NOT NULL AND `scheduled_run_at` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_scheduler_init_pending_idx`
	ON `sessions` (`created_at`, `session_id`)
	WHERE `scheduled_from_branch` = 1
		AND `scheduled_run_at` IS NOT NULL
		AND `scheduler_init_completed_at` IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=ON;
