-- Preserve accounting after conversation deletion. This table intentionally
-- has no foreign key to tasks or sessions: those rows are content lifecycle,
-- while this is the permanent usage ledger.
CREATE TABLE `task_usage_ledger` (
	`task_id` text(36) PRIMARY KEY NOT NULL,
	`session_id` text(36) NOT NULL,
	`user_id` text(36) NOT NULL,
	`agent_id` text(36),
	`agentic_tool` text NOT NULL,
	`model` text,
	`task_created_at` integer NOT NULL,
	`task_completed_at` integer,
	`recorded_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`token_usage_samples` text DEFAULT '[]' NOT NULL
);--> statement-breakpoint
CREATE INDEX `task_usage_ledger_created_idx` ON `task_usage_ledger` (`task_created_at`);--> statement-breakpoint
CREATE INDEX `task_usage_ledger_user_created_idx` ON `task_usage_ledger` (`user_id`,`task_created_at`);--> statement-breakpoint
CREATE INDEX `task_usage_ledger_model_idx` ON `task_usage_ledger` (`model`);--> statement-breakpoint
CREATE INDEX `task_usage_ledger_tool_idx` ON `task_usage_ledger` (`agentic_tool`);--> statement-breakpoint

INSERT INTO `task_usage_ledger` (
	`task_id`, `session_id`, `user_id`, `agent_id`, `agentic_tool`, `model`,
	`task_created_at`, `task_completed_at`, `recorded_at`, `updated_at`,
	`input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`,
	`cache_creation_tokens`, `cost_usd`, `duration_ms`, `token_usage_samples`
)
SELECT
	t.`task_id`,
	t.`session_id`,
	t.`created_by`,
	s.`agent_id`,
	s.`agentic_tool`,
	COALESCE(NULLIF(json_extract(t.`data`, '$.model'), ''), NULLIF(json_extract(t.`data`, '$.normalized_sdk_response.primaryModel'), '')),
	t.`created_at`,
	t.`completed_at`,
	CAST(unixepoch('subsec') * 1000 AS integer),
	CAST(unixepoch('subsec') * 1000 AS integer),
	COALESCE(CAST(json_extract(t.`data`, '$.normalized_sdk_response.tokenUsage.inputTokens') AS integer), 0),
	COALESCE(CAST(json_extract(t.`data`, '$.normalized_sdk_response.tokenUsage.outputTokens') AS integer), 0),
	COALESCE(CAST(json_extract(t.`data`, '$.normalized_sdk_response.tokenUsage.totalTokens') AS integer), 0),
	COALESCE(CAST(json_extract(t.`data`, '$.normalized_sdk_response.tokenUsage.cacheReadTokens') AS integer), 0),
	COALESCE(CAST(json_extract(t.`data`, '$.normalized_sdk_response.tokenUsage.cacheCreationTokens') AS integer), 0),
	COALESCE(CAST(json_extract(t.`data`, '$.normalized_sdk_response.costUsd') AS real), 0),
	COALESCE(
		CAST(json_extract(t.`data`, '$.normalized_sdk_response.durationMs') AS integer),
		CAST(json_extract(t.`data`, '$.duration_ms') AS integer),
		0
	),
	COALESCE(json_extract(t.`data`, '$.normalized_sdk_response.tokenUsageSamples'), '[]')
FROM `tasks` t
INNER JOIN `sessions` s ON s.`session_id` = t.`session_id`;--> statement-breakpoint

CREATE TRIGGER `tasks_sync_usage_ledger_insert`
AFTER INSERT ON `tasks`
BEGIN
	INSERT INTO `task_usage_ledger` (
		`task_id`, `session_id`, `user_id`, `agent_id`, `agentic_tool`, `model`,
		`task_created_at`, `task_completed_at`, `recorded_at`, `updated_at`,
		`input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`,
		`cache_creation_tokens`, `cost_usd`, `duration_ms`, `token_usage_samples`
	)
	SELECT
		NEW.`task_id`, NEW.`session_id`, NEW.`created_by`, s.`agent_id`, s.`agentic_tool`,
		COALESCE(NULLIF(json_extract(NEW.`data`, '$.model'), ''), NULLIF(json_extract(NEW.`data`, '$.normalized_sdk_response.primaryModel'), '')),
		NEW.`created_at`, NEW.`completed_at`,
		CAST(unixepoch('subsec') * 1000 AS integer),
		CAST(unixepoch('subsec') * 1000 AS integer),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.inputTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.outputTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.totalTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.cacheReadTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.cacheCreationTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.costUsd') AS real), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.durationMs') AS integer), CAST(json_extract(NEW.`data`, '$.duration_ms') AS integer), 0),
		COALESCE(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsageSamples'), '[]')
	FROM `sessions` s WHERE s.`session_id` = NEW.`session_id`
	ON CONFLICT(`task_id`) DO UPDATE SET
		`session_id` = excluded.`session_id`, `user_id` = excluded.`user_id`,
		`agent_id` = excluded.`agent_id`, `agentic_tool` = excluded.`agentic_tool`,
		`model` = excluded.`model`, `task_created_at` = excluded.`task_created_at`,
		`task_completed_at` = excluded.`task_completed_at`, `updated_at` = excluded.`updated_at`,
		`input_tokens` = excluded.`input_tokens`, `output_tokens` = excluded.`output_tokens`,
		`total_tokens` = excluded.`total_tokens`, `cache_read_tokens` = excluded.`cache_read_tokens`,
		`cache_creation_tokens` = excluded.`cache_creation_tokens`, `cost_usd` = excluded.`cost_usd`,
		`duration_ms` = excluded.`duration_ms`, `token_usage_samples` = excluded.`token_usage_samples`;
END;--> statement-breakpoint

CREATE TRIGGER `tasks_sync_usage_ledger_update`
AFTER UPDATE OF `data`, `completed_at`, `created_by`, `session_id` ON `tasks`
BEGIN
	INSERT INTO `task_usage_ledger` (
		`task_id`, `session_id`, `user_id`, `agent_id`, `agentic_tool`, `model`,
		`task_created_at`, `task_completed_at`, `recorded_at`, `updated_at`,
		`input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`,
		`cache_creation_tokens`, `cost_usd`, `duration_ms`, `token_usage_samples`
	)
	SELECT
		NEW.`task_id`, NEW.`session_id`, NEW.`created_by`, s.`agent_id`, s.`agentic_tool`,
		COALESCE(NULLIF(json_extract(NEW.`data`, '$.model'), ''), NULLIF(json_extract(NEW.`data`, '$.normalized_sdk_response.primaryModel'), '')),
		NEW.`created_at`, NEW.`completed_at`,
		CAST(unixepoch('subsec') * 1000 AS integer),
		CAST(unixepoch('subsec') * 1000 AS integer),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.inputTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.outputTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.totalTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.cacheReadTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsage.cacheCreationTokens') AS integer), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.costUsd') AS real), 0),
		COALESCE(CAST(json_extract(NEW.`data`, '$.normalized_sdk_response.durationMs') AS integer), CAST(json_extract(NEW.`data`, '$.duration_ms') AS integer), 0),
		COALESCE(json_extract(NEW.`data`, '$.normalized_sdk_response.tokenUsageSamples'), '[]')
	FROM `sessions` s WHERE s.`session_id` = NEW.`session_id`
	ON CONFLICT(`task_id`) DO UPDATE SET
		`session_id` = excluded.`session_id`, `user_id` = excluded.`user_id`,
		`agent_id` = excluded.`agent_id`, `agentic_tool` = excluded.`agentic_tool`,
		`model` = excluded.`model`, `task_created_at` = excluded.`task_created_at`,
		`task_completed_at` = excluded.`task_completed_at`, `updated_at` = excluded.`updated_at`,
		`input_tokens` = excluded.`input_tokens`, `output_tokens` = excluded.`output_tokens`,
		`total_tokens` = excluded.`total_tokens`, `cache_read_tokens` = excluded.`cache_read_tokens`,
		`cache_creation_tokens` = excluded.`cache_creation_tokens`, `cost_usd` = excluded.`cost_usd`,
		`duration_ms` = excluded.`duration_ms`, `token_usage_samples` = excluded.`token_usage_samples`;
END;
