-- Schedules are owned directly by a user and may target one persistent Agent.
-- Existing schedule rows belong to the retired Branch model and are deliberately
-- discarded; this release does not maintain a dual-write or compatibility path.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
ALTER TABLE `sessions` RENAME COLUMN `scheduled_from_branch` TO `is_scheduled`;--> statement-breakpoint
UPDATE `sessions` SET `schedule_id` = NULL WHERE `schedule_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `schedules`;--> statement-breakpoint
CREATE TABLE `schedules` (
	`schedule_id` text(36) PRIMARY KEY NOT NULL,
	`agent_id` text(36),
	`name` text NOT NULL,
	`description` text,
	`cron_expression` text NOT NULL,
	`timezone_mode` text DEFAULT 'local' NOT NULL,
	`timezone` text,
	`prompt` text NOT NULL,
	`agentic_tool_config` text NOT NULL,
	`agentic_tool_preset_id` text(36),
	`mcp_server_ids` text,
	`enabled` integer DEFAULT true NOT NULL,
	`allow_concurrent_runs` integer DEFAULT false NOT NULL,
	`retention` integer DEFAULT 5 NOT NULL,
	`last_run_at` integer,
	`last_run_session_id` text(36),
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text(36) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agentic_tool_preset_id`) REFERENCES `agentic_tool_presets`(`preset_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`last_run_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `schedules_enabled_next_run_idx` ON `schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `schedules_agentic_tool_preset_idx` ON `schedules` (`agentic_tool_preset_id`);--> statement-breakpoint
CREATE INDEX `schedules_agent_idx` ON `schedules` (`agent_id`);--> statement-breakpoint
CREATE INDEX `schedules_created_by_idx` ON `schedules` (`created_by`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
