CREATE TABLE `agents` (
	`agent_id` text(36) PRIMARY KEY NOT NULL,
	`created_by` text(36) NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`emoji` text,
	`avatar_url` text,
	`workspace_path` text NOT NULL,
	`state` text DEFAULT 'creating' NOT NULL,
	`error_message` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `agents_owner_idx` ON `agents` (`created_by`);--> statement-breakpoint
CREATE INDEX `agents_owner_archived_idx` ON `agents` (`created_by`,`archived`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `agent_id` text(36) REFERENCES agents(agent_id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `working_directory` text;--> statement-breakpoint
CREATE INDEX `sessions_agent_idx` ON `sessions` (`agent_id`);
