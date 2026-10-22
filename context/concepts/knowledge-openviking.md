# OpenViking and host Codex integration

Disco's portable library owns original files, Markdown, provenance, revisions and
deletion tombstones. OpenViking holds a rebuildable copy for semantic retrieval.
Never write an OpenViking summary back over an authoritative Markdown file.

## Identity boundary

Each authenticated `(tenantId, userId)` gets a separate OpenViking account:
`disco_` plus the first 32 hex characters of SHA-256 of the JSON array containing
those two IDs. The regular data user is `library`, role `user`. The administrative
root key is used only by deployment/provisioning, never by Disco data routes or
the host MCP bridge. Do not use development or trusted-header authentication.

`OpenVikingClient` verifies the real account, user, role and auth mode using an
authenticated `/health` before data requests. URI targets include the owner
account hash as defence in depth. Search responses are checked against the
requested prefix and selected entry IDs before returning IDs to the library.
Disco must still resolve those IDs against the current user's library and
tombstones; an index result is never authorization to read a file.

The service accepts a credential resolver; runtime configuration and credentials
stay outside the checkout. Provision a separate account admin and then a
`library` USER using the official Admin API. Do not retain that account's admin
key in the data-client identity list.

## Processing phases

1. Save complete archives and originals into the portable library.
2. Split a derived Markdown copy into ordered chunks of at most 3000 UTF-8 bytes,
   then index every chunk through `content/batch-write` with `processing_mode:
"vectors_only"`, at most sixteen chunks per transaction. Concatenation exactly reconstructs the source, including
   whitespace and Unicode. This bounds each local embedding input without
   silently losing the tail of a long conversation. This phase does not ask the
   VLM for summaries.
3. Run explicitly tracked, low-concurrency summarization jobs after the owner's
   archive pass and each eligible source's indexing. Explicit manual synthesis
   does not depend on semantic indexing. Derived summaries are separate drafts
   with source versions and topic/tag classification;
   human-edited Markdown is never a summarization target.

Each small write uses `wait: false`; the client polls its accepted task and waits
for completion before submitting the next batch. It retains accepted task IDs
across transient polling failures so a retry does not duplicate the same write.
Path-lock conflicts receive bounded retries, and persistent failures return to
the durable per-entry retry queue. The index call requires `vector_status: "complete"` or the provider's idempotent
`"skipped"` result when its index planner finds every vector current. A content
write, queued maintenance, timeout or partial result is not a completed index.
Retrying the same final content with `replace` is idempotent. The caller owns the
durable retry queue and must check the source content hash before marking it
indexed. Retrieval uses `search/find`, not an implicit session-planning LLM call.
Provider failures allow Disco to fall back to its scoped local search.

Each entry owns a separate directory with `content.md` followed by numbered
`part-0000000002.md` files. Shorter edits clear obsolete chunks and mark them
inactive using `vectors_only`; OpenViking's DELETE would otherwise invoke a
semantic refresh. Search requires `disco_index=active`, maps chunks to the entry
ID, and reads current matching content instead of a potentially stale summary.
Up to four retrieval rounds exclude already represented entry tags so one long
document's chunks cannot consume the entire result set. All rounds share one
request deadline. Owner-scoped keyword retrieval runs alongside semantic search;
rank fusion combines unique documents. Semantic excerpts must occur verbatim in
the current original, and keyword excerpts are chosen around matched terms.
Returned match offsets and content hashes let readers verify the source passage.

The separate `scripts/knowledge-summarize.py` process calls the configured Codex
subscription provider without tools. Small sources use one completion; large
sources are split losslessly into at most 64,000 UTF-8 bytes per map input, then
their summaries are recursively merged into bounded groups. Calls run in order
with a two-second pause between new completions. Source context follows chunks
that begin midway through a document, preserving source IDs and links. Prompts
extract conclusions, decisions, reusable methods and unresolved conflicts instead
of rewriting the transcript in chronological order. Input is never truncated,
and original library files are never written by the helper.
Prompt version v7 permits an explicit `archiveOnly` decision for greeting-only,
connection-test or no-action records without reusable information. Short but
substantive preferences or decisions remain eligible. Automatic organization
records the disposition without producing a knowledge note; explicit synthesis
still receives a truthful explanatory summary.

Optional typed `sources` accompany the backwards-compatible `content` input.
The pure local `scripts/knowledge_overview.py` module fully scans JSON/CSV
structures, counts fields and records, and extracts complete static HTML text
without executing scripts or fetching resources. Structured-only automatic
requests return `summaryMode: structured_overview` without initializing a VLM;
the overview explains its limits and preserves source links. Large coordinate
arrays, record tables and HTML application scripts are not sent to the model.
Recognized narrative fields, short rules/preferences and ordinary narrative
documents remain complete inputs. Invalid/unrecognized formats conservatively
retain the complete Markdown. Explicit `forceSynthesis` or mixed narrative
sources uses the model on the prepared input, returning `summaryMode: model`.
This preparation never modifies the portable source or claims row-by-row
knowledge extraction from a structural overview.

The helper guards the installed Codex adapter's synchronous Responses stream:
failed/incomplete or missing completion events cannot become partial successes.
It accepts a complete JSON object inside a presentation wrapper, but never
repairs malformed/truncated JSON or selects one of several conflicting objects.
Fixed failure codes distinguish formatting, interruption, timeout, connectivity,
authentication, quota, model/configuration and local cache errors. Logs include
only bounded structural diagnostics, never response bodies or credentials.
The provider supplies minimum retry delays appropriate to those categories.

Intermediate results are resumable under the protected operator configuration
directory's `summary-work/<owner-account-hash>/<entry-id>/`, keyed by content,
instructions, model and prompt version. A ten-minute job timeout therefore does
not repeat already completed cloud calls on retry. Explicit entry deletion
cancels only that entry's helper, writes a deletion marker to prevent late cache
resurrection, and removes its derived cache. Cache filesystem failure is logged
without undoing a successful original/vector deletion. No new automatic expiry
policy is introduced by this cache. Source hash and human-edit checks protect
acceptance of the final result. Jobs are serialized and start at least one minute
apart across owners. Asynchronous vector deletion is polled to completion.

Disco currently extracts PDF/Office text locally before this adapter, preserving
original bytes in the portable library. OpenViking also has a separate
`resources/temp_upload` then `resources` API, with `processing_mode:
"vectors_only"`; raw HTTP ingestion cannot read arbitrary server-local paths.
Cloud parser and audio/video understanding settings must not be enabled merely
to make file upload work.

## Windows deployment

The selected installation is an independent Python 3.12.15 environment under
`E:\Disco\runtimes\openviking`, using the published Windows wheel for
OpenViking `0.5.1.1`. The native Windows Ollama CLI runs separately. Model files,
package caches, temporary files, OpenViking storage, and logs belong on E:,
outside the source checkout. Both HTTP services bind to loopback only.
`scripts/start-knowledge-services.ps1` starts them hidden and reuses only verified
existing processes. It derives `index-only.conf` from the operator's `ov.conf`,
with `vlm={}`. The index service has no cloud VLM, including automatic deletion
maintenance. Only the separately scheduled summary helper reads the original
VLM configuration and receives the configured host OAuth import paths.
Set `NO_PROXY=127.0.0.1,localhost,::1` on the OpenViking
process: Python otherwise inherits the Windows system proxy even for loopback.
A successful `/ready` probe alone is insufficient; verify a real embedding
request and a user-scoped indexed search. The system Python 3.10.8 showed a
Windows Proactor queue-thread failure during integration testing and is not the
deployment interpreter.

The initial local embedding model is `qwen3-embedding:0.6b` (Q8, about 639 MB),
served by Ollama. Verify the actual output dimension before creating an index;
changing model or dimension later requires a fresh index. The user has approved
the existing host Codex subscription for low-speed summarization. That is a
separate VLM configuration and does not provide embedding credits.

Keep the OpenViking config outside the repository. Its relevant configuration
shape is:

```json
{
  "storage": {
    "workspace": "E:/Disco/data/openviking",
    "vectordb": { "backend": "local" },
    "agfs": { "backend": "local" }
  },
  "server": {
    "host": "127.0.0.1",
    "port": 1933,
    "auth_mode": "api_key",
    "root_api_key": "<runtime secret>"
  },
  "embedding": {
    "dense": {
      "provider": "ollama",
      "api_base": "http://127.0.0.1:11434/v1",
      "model": "qwen3-embedding:0.6b",
      "dimension": 1024
    }
  },
  "vlm": {
    "provider": "openai-codex",
    "model": "<validated host model>",
    "api_base": "https://chatgpt.com/backend-api/codex",
    "max_concurrent": 1,
    "media": { "enabled": false }
  },
  "pdf": { "strategy": "local" }
}
```

Use the provider's supported Codex OAuth import flow. Do not print tokens, copy
the whole host Codex state into the shared Disco runtime, or use a root service
key as a host user's credential. Keep cloud summarization paused until both the
local embedding connection and user-isolated round-trip checks pass.

`OpenVikingOptions.summary` uses absolute paths: `pythonExecutable`, `scriptPath`,
`configPath`, and optional `codexAuthFile` / `authStorePath`. Production script paths
belong under the deployed source directory; runtime credentials remain outside
it. The helper reads archives only from stdin and returns only validated summary
JSON. Provider exceptions and stderr are not exposed to users. OpenViking 0.5.1.1's
Codex client cleanup lacks `close()` on its shim; that specific cleanup exception
is suppressed in this isolated helper so it does not discard valid output.

## Retrieval and synthesis operating behavior

Keyword counts are warmed in the background per owner, refreshed when document
versions change, and shared with concurrent searches. Exact technical identifiers
(error names, paths, codes) require literal evidence. Unparsed file metadata cannot
support a semantic claim about that file's contents. Every returned passage is
checked against the current owner-scoped Markdown and includes versioned offsets.

Summary inputs are format-aware. `scripts/knowledge_overview.py` scans structured
JSON and CSV locally and extracts static HTML text without executing scripts.
It preserves narrative fields and short rules in full for model synthesis. Pure
data inventories are marked `structured_overview`, explain their limits, and do
not call a model. Their generation does not consume the model cooldown; small
local batches yield between owners. Explicit cross-source requests still run
model synthesis over prepared sources. Ordinary narrative archives remain whole
and use resumable chunked synthesis.

The UI uses one catalog response, bounded reading windows, complete Markdown
downloads, and complete-body loads before editing. Source navigation has a return
history, and users can inspect or remove every selected source before organizing.
Malformed file parsing backs off instead of relaunching a parser on every scan;
replacing the original resets this retry state.

## Host MCP

`scripts/knowledge-host-mcp.mjs` exposes search, list, paged read, save, revision-
checked update and explicit deletion. It reads `DISCO_KNOWLEDGE_HOST_CONFIG`, a
runtime JSON file with `baseUrl` and `token`. That token is bound by Disco to the
host/RESKIP private-library owner and is limited to knowledge routes. Neither
tenant/user IDs nor OpenViking credentials are accepted from tool arguments.

Codex's MCP entry uses Node to start that script with stdio transport, and passes
only the config path through the environment. The script resolves the repository's
installed MCP SDK; it does not download dependencies on launch. Every source is
untrusted reference content. A tool description encourages relevant historical
retrieval, but it alone does not guarantee retrieval on every prompt.

Read pagination returns `offset`, `nextOffset`, `totalCharacters`, and `hasMore`.
Only the response is paginated: the original archive is not truncated. Search
excerpts are previews, and the caller follows entry IDs to read source text.
Update and delete are marked destructive; auto-generated summaries may not call
update to overwrite human-authored content.

## References

- [Content and batch writes](https://docs.openviking.ai/en/api/12-content)
- [Retrieval](https://docs.openviking.ai/en/api/06-retrieval)
- [Resource import](https://docs.openviking.ai/en/api/02-resources)
- [Authentication](https://docs.openviking.ai/en/guides/04-authentication)
- [System identity probes](https://docs.openviking.ai/en/api/07-system)
- [Model configuration](https://docs.openviking.ai/en/guides/01-configuration)
- [Windows server setup](https://docs.openviking.ai/en/getting-started/04-setup-for-agent)
- [Ollama for Windows](https://docs.ollama.com/windows)
- [Qwen3 embedding model](https://ollama.com/library/qwen3-embedding:0.6b)
- [Official OpenAI documentation: MCP](https://learn.chatgpt.com/docs/extend/mcp)
