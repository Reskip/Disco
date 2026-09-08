-- Preserve accounting after conversation deletion. This table intentionally
-- has no foreign key to tasks or sessions: those rows are content lifecycle,
-- while this is the permanent usage ledger.
CREATE TABLE "task_usage_ledger" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"task_id" varchar(36) PRIMARY KEY NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"agent_id" varchar(36),
	"agentic_tool" text NOT NULL,
	"model" text,
	"task_created_at" timestamp with time zone NOT NULL,
	"task_completed_at" timestamp with time zone,
	"recorded_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"token_usage_samples" jsonb DEFAULT '[]'::jsonb NOT NULL
);--> statement-breakpoint
CREATE INDEX "task_usage_ledger_tenant_id_idx" ON "task_usage_ledger" ("tenant_id");--> statement-breakpoint
CREATE INDEX "task_usage_ledger_tenant_created_idx" ON "task_usage_ledger" ("tenant_id","task_created_at");--> statement-breakpoint
CREATE INDEX "task_usage_ledger_tenant_user_created_idx" ON "task_usage_ledger" ("tenant_id","user_id","task_created_at");--> statement-breakpoint
CREATE INDEX "task_usage_ledger_tenant_model_idx" ON "task_usage_ledger" ("tenant_id","model");--> statement-breakpoint
CREATE INDEX "task_usage_ledger_tenant_tool_idx" ON "task_usage_ledger" ("tenant_id","agentic_tool");--> statement-breakpoint

-- Backfill before RLS is enabled so upgrades retain all existing accounting.
INSERT INTO "task_usage_ledger" (
	"tenant_id", "task_id", "session_id", "user_id", "agent_id",
	"agentic_tool", "model", "task_created_at", "task_completed_at",
	"recorded_at", "updated_at", "input_tokens", "output_tokens",
	"total_tokens", "cache_read_tokens", "cache_creation_tokens",
	"cost_usd", "duration_ms", "token_usage_samples"
)
SELECT
	t."tenant_id",
	t."task_id",
	t."session_id",
	t."created_by",
	s."agent_id",
	s."agentic_tool",
	COALESCE(NULLIF(t."data"->>'model', ''), NULLIF(t."data" #>> '{normalized_sdk_response,primaryModel}', '')),
	t."created_at",
	t."completed_at",
	CURRENT_TIMESTAMP,
	CURRENT_TIMESTAMP,
	COALESCE((t."data" #>> '{normalized_sdk_response,tokenUsage,inputTokens}')::bigint, 0),
	COALESCE((t."data" #>> '{normalized_sdk_response,tokenUsage,outputTokens}')::bigint, 0),
	COALESCE((t."data" #>> '{normalized_sdk_response,tokenUsage,totalTokens}')::bigint, 0),
	COALESCE((t."data" #>> '{normalized_sdk_response,tokenUsage,cacheReadTokens}')::bigint, 0),
	COALESCE((t."data" #>> '{normalized_sdk_response,tokenUsage,cacheCreationTokens}')::bigint, 0),
	COALESCE((t."data" #>> '{normalized_sdk_response,costUsd}')::double precision, 0),
	COALESCE(
		(t."data" #>> '{normalized_sdk_response,durationMs}')::bigint,
		(t."data"->>'duration_ms')::bigint,
		0
	),
	COALESCE(t."data" #> '{normalized_sdk_response,tokenUsageSamples}', '[]'::jsonb)
FROM "tasks" t
INNER JOIN "sessions" s
	ON s."tenant_id" = t."tenant_id" AND s."session_id" = t."session_id";--> statement-breakpoint

CREATE OR REPLACE FUNCTION "disco_sync_task_usage_ledger"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	previous_tenant text;
BEGIN
	-- Task writes can also originate from narrow internal repositories that do
	-- not establish a request tenant scope. Bind only this trigger statement to
	-- NEW.tenant_id so the forced ledger RLS policy remains effective, then
	-- restore the caller's transaction-local setting before returning.
	previous_tenant := current_setting('disco.tenant_id', true);
	PERFORM set_config('disco.tenant_id', NEW."tenant_id", true);
	INSERT INTO "task_usage_ledger" (
		"tenant_id", "task_id", "session_id", "user_id", "agent_id",
		"agentic_tool", "model", "task_created_at", "task_completed_at",
		"recorded_at", "updated_at", "input_tokens", "output_tokens",
		"total_tokens", "cache_read_tokens", "cache_creation_tokens",
		"cost_usd", "duration_ms", "token_usage_samples"
	)
	SELECT
		NEW."tenant_id",
		NEW."task_id",
		NEW."session_id",
		NEW."created_by",
		s."agent_id",
		s."agentic_tool",
		COALESCE(NULLIF(NEW."data"->>'model', ''), NULLIF(NEW."data" #>> '{normalized_sdk_response,primaryModel}', '')),
		NEW."created_at",
		NEW."completed_at",
		CURRENT_TIMESTAMP,
		CURRENT_TIMESTAMP,
		COALESCE((NEW."data" #>> '{normalized_sdk_response,tokenUsage,inputTokens}')::bigint, 0),
		COALESCE((NEW."data" #>> '{normalized_sdk_response,tokenUsage,outputTokens}')::bigint, 0),
		COALESCE((NEW."data" #>> '{normalized_sdk_response,tokenUsage,totalTokens}')::bigint, 0),
		COALESCE((NEW."data" #>> '{normalized_sdk_response,tokenUsage,cacheReadTokens}')::bigint, 0),
		COALESCE((NEW."data" #>> '{normalized_sdk_response,tokenUsage,cacheCreationTokens}')::bigint, 0),
		COALESCE((NEW."data" #>> '{normalized_sdk_response,costUsd}')::double precision, 0),
		COALESCE(
			(NEW."data" #>> '{normalized_sdk_response,durationMs}')::bigint,
			(NEW."data"->>'duration_ms')::bigint,
			0
		),
		COALESCE(NEW."data" #> '{normalized_sdk_response,tokenUsageSamples}', '[]'::jsonb)
	FROM "sessions" s
	WHERE s."tenant_id" = NEW."tenant_id" AND s."session_id" = NEW."session_id"
	ON CONFLICT ("task_id") DO UPDATE SET
		"tenant_id" = EXCLUDED."tenant_id",
		"session_id" = EXCLUDED."session_id",
		"user_id" = EXCLUDED."user_id",
		"agent_id" = EXCLUDED."agent_id",
		"agentic_tool" = EXCLUDED."agentic_tool",
		"model" = EXCLUDED."model",
		"task_created_at" = EXCLUDED."task_created_at",
		"task_completed_at" = EXCLUDED."task_completed_at",
		"updated_at" = EXCLUDED."updated_at",
		"input_tokens" = EXCLUDED."input_tokens",
		"output_tokens" = EXCLUDED."output_tokens",
		"total_tokens" = EXCLUDED."total_tokens",
		"cache_read_tokens" = EXCLUDED."cache_read_tokens",
		"cache_creation_tokens" = EXCLUDED."cache_creation_tokens",
		"cost_usd" = EXCLUDED."cost_usd",
		"duration_ms" = EXCLUDED."duration_ms",
		"token_usage_samples" = EXCLUDED."token_usage_samples";
	PERFORM set_config('disco.tenant_id', COALESCE(previous_tenant, ''), true);
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "tasks_sync_usage_ledger_insert"
	AFTER INSERT ON "tasks"
	FOR EACH ROW EXECUTE FUNCTION "disco_sync_task_usage_ledger"();--> statement-breakpoint
CREATE TRIGGER "tasks_sync_usage_ledger_update"
	AFTER UPDATE OF "data", "completed_at", "created_by", "session_id" ON "tasks"
	FOR EACH ROW EXECUTE FUNCTION "disco_sync_task_usage_ledger"();--> statement-breakpoint

ALTER TABLE "task_usage_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_usage_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_task_usage_ledger" ON "task_usage_ledger"
	USING ("tenant_id" = NULLIF(current_setting('disco.tenant_id', true), ''))
	WITH CHECK ("tenant_id" = NULLIF(current_setting('disco.tenant_id', true), ''));
