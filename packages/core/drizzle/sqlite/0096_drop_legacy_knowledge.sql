DELETE FROM `app_variables`
WHERE `namespace` = 'knowledge'
   OR `namespace` LIKE 'knowledge.%';
--> statement-breakpoint
UPDATE `branches`
SET `data` = json_remove(
  `data`,
  '$.custom_context.teammate.kb',
  '$.custom_context.assistant.kb',
  '$.custom_context.agent.kb'
)
WHERE json_valid(`data`)
  AND (
    json_type(`data`, '$.custom_context.teammate.kb') IS NOT NULL
    OR json_type(`data`, '$.custom_context.assistant.kb') IS NOT NULL
    OR json_type(`data`, '$.custom_context.agent.kb') IS NOT NULL
  );
--> statement-breakpoint
DROP TABLE IF EXISTS `kb_unit_embeddings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `kb_graph_edges`;
--> statement-breakpoint
DROP TABLE IF EXISTS `kb_graph_nodes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `kb_document_units`;
--> statement-breakpoint
DROP TABLE IF EXISTS `kb_document_versions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `kb_documents`;
--> statement-breakpoint
DROP TABLE IF EXISTS `kb_namespace_acl`;
--> statement-breakpoint
DROP TABLE IF EXISTS `kb_namespaces`;
--> statement-breakpoint
DROP TABLE IF EXISTS `kb_embedding_spaces`;
