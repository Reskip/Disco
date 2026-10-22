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
Three independent background workers handle archival, extraction/indexing, and
knowledge organization. A slow embedding request or model completion cannot
hold up the next archive scan. The archive worker starts three seconds after
startup, then schedules its next scan thirty seconds after the current scan
finishes. This is a polling interval, not a promise that a large first import
finishes within thirty seconds. Index work resumes three seconds after its pass;
the summary scheduler checks every fifteen seconds and starts jobs at least one
minute apart, rotating owners. Shutdown cancels owned index/model operations.

For current host Codex versions, the archive reader uses the explicitly selected
home's `state_N.sqlite` and `thread_history_N.sqlite` in read-only/query-only mode.
It includes active, archived, and history-only deleted threads. A separate fixed
Node child process performs catalog scans and full row export so synchronous
SQLite and large JSON decoding cannot block chat HTTP/realtime. Complete raw
rows, tool data, metadata, and provenance stream into a SHA-256-verified JSONL
archive; readable Markdown projects the conversation. Legacy JSONL sessions are
still imported, and pre-migration copies are retained as revisions. No host
authentication/configuration data is imported. Owned Disco sessions and retained
uploads continue to import under their respective authenticated users.

Automatic summaries start after that owner's first archive pass and only for
eligible indexed sources. A failed file or another user's backlog does not block
all summaries indefinitely. Manual synthesis requests can run before semantic
indexing and are persisted as queued draft notes. Failed index and summary jobs
store a clear message, attempt count and retry time; exponential backoff starts
at thirty seconds and caps at thirty minutes. Other entries remain eligible.
Notes have index priority, and unsupported originals remain downloadable with an
explicit parsing status rather than being presented as parsed text.

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

## Organization and human editing

The library distinguishes source archives, summary drafts, and reusable knowledge
notes. Format filters distinguish conversations, text documents, images, files,
and notes independently of processing success. Topic, tags, provenance and
draft/reviewed state accompany each entry. Generated titles are short subject
names. Automatic topic classification uses a small stable set: 软件与系统、工作与项目、
学习与研究、硬件与设备、健康与运动、旅行与生活、创作与设计、财务与消费、其他.
Project names and narrower terms belong in tags; users may choose their own topic.

Users can select sources and either create a manual synthesis template or queue
automatic synthesis, then edit the resulting Markdown and classification. Notes
link back to the selected sources, and source availability is checked in the same
owner library. Editing a queued/generated note takes ownership away from the
worker. Saving uses optimistic revision checks; background results and later
source changes must never overwrite the human title, Markdown or classification.
Old divergent archive versions are retained but excluded from ordinary lists,
automatic organization and current progress counts.

`disco_knowledge_search/read/save/delete` are available to both standalone and
agent conversations. The host bridge additionally exposes list/update. Retrieval
instructions use knowledge only for relevant history/material questions and
respect explicit scopes; archive contents never grant tool authorization.

The local worker is enabled in standalone mode. Auth-derived multitenancy learns
owners from authenticated requests; a distributed/cloud installation needs its
own scheduler and storage composition. Provider errors fall back to scoped local
text search. The page displays separate archive, index and organization progress,
last sync time, current work, parsing status and per-entry retry diagnostics;
queued or failed provider work is not reported as completed.

Directory filtering supports `processing=index_error|parse_error|metadata_only|
summary_error` before pagination. The overview provides separate original/note
issue counts; clicking a count opens the corresponding filtered collection.
`metadata_only` means the original is retained and its name/type/source are
searchable, not that its image or binary contents were understood. A source's
summary error is current only while it has no completed summary disposition;
a note uses its explicit failed generation state. These filters never move raw
materials into the knowledge-note collection or hide their download links.

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
