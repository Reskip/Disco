CREATE TABLE "agents" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"agent_id" varchar(36) PRIMARY KEY NOT NULL,
	"created_by" varchar(36) NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"emoji" text,
	"avatar_url" text,
	"workspace_path" text NOT NULL,
	"state" text DEFAULT 'creating' NOT NULL,
	"error_message" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX "agents_tenant_id_idx" ON "agents" ("tenant_id");--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" ("created_by");--> statement-breakpoint
CREATE INDEX "agents_owner_archived_idx" ON "agents" ("created_by","archived");--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_agents" ON "agents"
	USING ("tenant_id" = NULLIF(current_setting('disco.tenant_id', true), ''))
	WITH CHECK ("tenant_id" = NULLIF(current_setting('disco.tenant_id', true), ''));--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_id" varchar(36);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "working_directory" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_agent_id_fk"
	FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_agent_idx" ON "sessions" ("agent_id");
