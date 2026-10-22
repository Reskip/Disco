# Knowledge base

## Library and background work

The authenticated `/knowledge` API and the `/knowledge` UI page expose one
portable library per tenant/user. The page is reachable from Home and Settings.
Ordinary Markdown, complete source JSONL, original attachments, revisions,
provenance and persistent deletion tombstones are exported together as ZIP64.
Opening a list does not download document bodies or attachments. Chrome can
stream an export to a user-selected local file; other browsers use a Blob fallback.

The operator-only `DISCO_KNOWLEDGE_CONFIG` JSON maps the host Codex home to a
specific Disco tenant/user. Only that user shares the host archive and MCP
connector. Credentials are not stored in the source checkout or export.
The local worker scans active and archived host transcripts plus all owned Disco
sessions and active uploads. It first archives originals, then builds local
semantic indexes, then processes at most one summary per minute across owners
in rotating order. It does not overwrite user-edited Markdown. Summaries are
separate, versioned notes with links to their sources.

Transcript file times alone do not determine which copy is newer: a raw SHA-256
prefix proves an append, while divergent copies are preserved separately.
Linked host files are resolved only under approved attachment roots or a safe
transcript working directory, with no directory-wide import. Missing references
remain in the readable archive. Unchanged transcripts recheck attachments every
ten minutes; document parser status is durable so interrupted work resumes.
PDF, DOCX, XLSX and PPTX extraction runs locally; unsupported files retain their
original bytes and display an explicit parsing status. Scanned PDFs need OCR
before their text can be searched.

Direct Markdown edits are picked up during background reconciliation. Source
session deletion leaves the independent archive intact. Explicit library deletion
also removes unedited derived notes and the search copy, and creates a tombstone
that survives re-import and export. Human-edited derived notes remain independent.

`disco_knowledge_search/read/save/delete` are available to both standalone and
agent conversations. The host bridge additionally exposes list/update. Retrieval
instructions use knowledge only for relevant history/material questions and
respect explicit scopes; archive contents never grant tool authorization.

The local worker is enabled in standalone mode. Auth-derived multitenancy learns
owners from authenticated requests; a distributed/cloud installation needs its
own scheduler and storage composition. Provider errors fall back to scoped local
text search. The page displays pending indexes, parsing status and sync progress;
queued or failed provider work is not reported as completed.

## Executor trust boundary

Knowledge files belong inside their owner's existing tenant-aware
`worktrees/user-*/.disco/knowledge/library` directory. HTTP, MCP, retrieval,
exports and background workers must all resolve that owner from trusted server
context. A central registry must not become a second readable copy of users'
private content.

On this Windows deployment, personal Disco Codex sessions currently run with
`danger-full-access` and `approvalPolicy: never`; the account filesystem rule is
a runtime model instruction, not an operating-system security boundary. Moving
knowledge files under the established user directory preserves that existing
software trust boundary; it does not stop hostile code executing under the same
Windows identity from opening another account's files.

The daemon injects `DISCO_KNOWLEDGE_PRIVATE_ROOTS` as a JSON array of absolute
paths for service-owned storage, including OpenViking's central index and any
derived content. The runtime instruction additionally excludes the parent of
`DISCO_KNOWLEDGE_CONFIG` (or `DISCO_DATA_HOME/knowledge` by default) and
`DISCO_HOST_CODEX_HOME`, covering aliases when they can be resolved. Disco tasks
must use their authenticated knowledge tools instead of reading service
credentials, traversing host Codex history or calling the index service
directly. The host Codex connector runs outside this Disco instruction scope.

These instructions do not constitute hard tenant isolation. A deployment with
mutually untrusted users requires distinct OS execution identities or isolated
containers/VMs, with server credentials inaccessible to those workloads and
network access to the index service restricted. Do not enable shared Codex
Windows sandbox-account ACL mutation as a substitute: concurrent users share
those accounts, so per-session ACL changes interfere with each other.
