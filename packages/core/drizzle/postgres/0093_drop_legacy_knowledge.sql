DELETE FROM "app_variables"
WHERE "namespace" = 'knowledge'
   OR "namespace" LIKE 'knowledge.%';
--> statement-breakpoint
UPDATE "branches"
SET "data" = jsonb_set(
  "data",
  '{custom_context,teammate}',
  ("data"->'custom_context'->'teammate') - 'kb',
  false
)
WHERE jsonb_typeof("data"->'custom_context'->'teammate') = 'object'
  AND ("data"->'custom_context'->'teammate') ? 'kb';
--> statement-breakpoint
UPDATE "branches"
SET "data" = jsonb_set(
  "data",
  '{custom_context,assistant}',
  ("data"->'custom_context'->'assistant') - 'kb',
  false
)
WHERE jsonb_typeof("data"->'custom_context'->'assistant') = 'object'
  AND ("data"->'custom_context'->'assistant') ? 'kb';
--> statement-breakpoint
UPDATE "branches"
SET "data" = jsonb_set(
  "data",
  '{custom_context,agent}',
  ("data"->'custom_context'->'agent') - 'kb',
  false
)
WHERE jsonb_typeof("data"->'custom_context'->'agent') = 'object'
  AND ("data"->'custom_context'->'agent') ? 'kb';
--> statement-breakpoint
DROP TABLE IF EXISTS "kb_unit_embeddings" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "kb_graph_edges" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "kb_graph_nodes" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "kb_document_units" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "kb_document_versions" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "kb_documents" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "kb_namespace_acl" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "kb_namespaces" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "kb_embedding_spaces" CASCADE;
