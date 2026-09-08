-- Remove the final Repo/Branch/Board/Card/Artifact, gateway, and legacy
-- database-knowledge carrier tables.
-- Session identity is now user + optional Agent + working_directory, so the
-- retired board_id/branch_id columns are discarded rather than migrated.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`session_id` text(36) PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`created_by` text(36) NOT NULL,
	`agent_id` text(36),
	`working_directory` text,
	`unix_username` text,
	`status` text NOT NULL,
	`agentic_tool` text NOT NULL,
	`agentic_tool_preset_id` text(36),
	`parent_session_id` text(36),
	`forked_from_session_id` text(36),
	`scheduled_run_at` integer,
	`is_scheduled` integer DEFAULT false NOT NULL,
	`schedule_id` text(36),
	`scheduler_init_completed_at` integer,
	`ready_for_prompt` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`archived_reason` text,
	`data` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agentic_tool_preset_id`) REFERENCES `agentic_tool_presets`(`preset_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`schedule_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_sessions` (
	`session_id`, `created_at`, `updated_at`, `created_by`, `agent_id`,
	`working_directory`, `unix_username`, `status`, `agentic_tool`,
	`agentic_tool_preset_id`, `parent_session_id`, `forked_from_session_id`,
	`scheduled_run_at`, `is_scheduled`, `schedule_id`,
	`scheduler_init_completed_at`, `ready_for_prompt`, `archived`,
	`archived_reason`, `data`
) SELECT
	`session_id`, `created_at`, `updated_at`, `created_by`, `agent_id`,
	`working_directory`, `unix_username`, `status`, `agentic_tool`,
	`agentic_tool_preset_id`, `parent_session_id`, `forked_from_session_id`,
	`scheduled_run_at`, `is_scheduled`, `schedule_id`,
	`scheduler_init_completed_at`, `ready_for_prompt`, `archived`,
	`archived_reason`, `data`
FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);--> statement-breakpoint
CREATE INDEX `sessions_status_ready_idx` ON `sessions` (`status`,`ready_for_prompt`);--> statement-breakpoint
CREATE INDEX `sessions_agentic_tool_idx` ON `sessions` (`agentic_tool`);--> statement-breakpoint
CREATE INDEX `sessions_agentic_tool_preset_idx` ON `sessions` (`agentic_tool_preset_id`);--> statement-breakpoint
CREATE INDEX `sessions_agent_idx` ON `sessions` (`agent_id`);--> statement-breakpoint
CREATE INDEX `sessions_created_idx` ON `sessions` (`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_parent_idx` ON `sessions` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_forked_idx` ON `sessions` (`forked_from_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_scheduled_flag_idx` ON `sessions` (`is_scheduled`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_schedule_run_unique` ON `sessions` (`schedule_id`,`scheduled_run_at`)
	WHERE `schedule_id` IS NOT NULL AND `scheduled_run_at` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_scheduler_init_pending_idx` ON `sessions` (`created_at`,`session_id`)
	WHERE `is_scheduled` = 1
		AND `scheduled_run_at` IS NOT NULL
		AND `scheduler_init_completed_at` IS NULL;--> statement-breakpoint
DROP TABLE IF EXISTS `artifact_trust_grants`;--> statement-breakpoint
DROP TABLE IF EXISTS `board_comments`;--> statement-breakpoint
DROP TABLE IF EXISTS `board_group_grants`;--> statement-breakpoint
DROP TABLE IF EXISTS `board_owners`;--> statement-breakpoint
DROP TABLE IF EXISTS `branch_group_grants`;--> statement-breakpoint
DROP TABLE IF EXISTS `branch_owners`;--> statement-breakpoint
DROP TABLE IF EXISTS `cards`;--> statement-breakpoint
DROP TABLE IF EXISTS `card_types`;--> statement-breakpoint
DROP TABLE IF EXISTS `board_objects`;--> statement-breakpoint
DROP TABLE IF EXISTS `artifacts`;--> statement-breakpoint
DROP TABLE IF EXISTS `gateway_inbound_events`;--> statement-breakpoint
DROP TABLE IF EXISTS `gateway_outbound_messages`;--> statement-breakpoint
DROP TABLE IF EXISTS `gateway_channels`;--> statement-breakpoint
DROP TABLE IF EXISTS `thread_session_map`;--> statement-breakpoint
DROP TABLE IF EXISTS `kb_document_units`;--> statement-breakpoint
DROP TABLE IF EXISTS `kb_document_versions`;--> statement-breakpoint
DROP TABLE IF EXISTS `kb_documents`;--> statement-breakpoint
DROP TABLE IF EXISTS `kb_embedding_spaces`;--> statement-breakpoint
DROP TABLE IF EXISTS `kb_graph_edges`;--> statement-breakpoint
DROP TABLE IF EXISTS `kb_graph_nodes`;--> statement-breakpoint
DROP TABLE IF EXISTS `kb_namespace_acl`;--> statement-breakpoint
DROP TABLE IF EXISTS `kb_namespaces`;--> statement-breakpoint
DROP TABLE IF EXISTS `boards`;--> statement-breakpoint
DROP TABLE IF EXISTS `branches`;--> statement-breakpoint
DROP TABLE IF EXISTS `repos`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
