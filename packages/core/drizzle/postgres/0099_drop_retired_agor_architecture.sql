-- Remove the final Repo/Branch/Board/Card/Artifact, gateway, and legacy
-- database-knowledge carrier tables.
-- Session identity is now user + optional Agent + working_directory.
DROP INDEX IF EXISTS "sessions_board_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "sessions_branch_idx";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_board_id_boards_board_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_branch_id_branches_branch_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "board_id";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "branch_id";--> statement-breakpoint
DROP TABLE IF EXISTS "artifact_trust_grants" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "board_comments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "board_group_grants" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "board_owners" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "branch_group_grants" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "branch_owners" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "cards" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "card_types" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "board_objects" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "artifacts" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_inbound_events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_outbound_messages" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "gateway_channels" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "thread_session_map" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kb_document_units" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kb_document_versions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kb_documents" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kb_embedding_spaces" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kb_graph_edges" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kb_graph_nodes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kb_namespace_acl" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "kb_namespaces" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "boards" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "branches" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "repos" CASCADE;
