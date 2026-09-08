# Disco contributor guide

Disco is a private, multi-user browser interface for Codex. The product is
conversation-first: each account can start standalone conversations or talk to
persistent agents. Runtime conversations do not require a Git repository,
branch, board, or worktree checkout.

The code is the source of truth. Read the relevant implementation before
changing behavior, and keep user-facing copy in Chinese unless a protocol or
provider name must remain in English.

## Product model

- **Standalone conversation** — belongs to one user and runs in its own
  `standalone/<session-id>` directory. It has no default persona, duties,
  memories, or agent-owned skills.
- **Agent** — belongs to one user and has one persistent workspace shared by
  all conversations with that agent; each conversation works from a separate
  `sessions/<session-id>` subdirectory. Its duties, memories, and self-created
  abilities survive between conversations.
- **Task** — one user turn. A running task may accept a non-interrupting
  supplemental instruction; a separate prompt may be durably queued as the
  next task.
- **Shared skill** — a server-wide Codex skill visible in Settings. An admin can
  enable or disable it for every account.
- **Agent ability or memory** — an item stored in that agent's own workspace and
  managed explicitly from Settings.

## Runtime storage contract

Configure the runtime data root with `DISCO_DATA_HOME`, outside the source checkout.
Do not reintroduce a runtime dependency on Git repositories or Git worktrees.

```text
data/disco/
├── uploads/                         # retained uploaded assets
└── worktrees/
    └── <user-id>/
        ├── standalone/              # no persona or skill files
        │   └── <session-id>/         # one resource directory per conversation
        └── agents/
            └── <agent-id>/
                ├── AGENTS.md
                ├── .disco/
                │   ├── IDENTITY.md
                │   ├── RESPONSIBILITIES.md
                │   ├── USER.md
                │   ├── MEMORY.md
                │   ├── capabilities.json
                │   └── memory/
                ├── skills/
                │   └── <skill>/SKILL.md
                └── sessions/
                    └── <session-id>/ # one resource directory per conversation
```

Workspace creation must be idempotent. Never overwrite files an agent has
already updated. On Windows, new Markdown instruction files use UTF-8 with BOM
so Windows PowerShell 5.1 reads Chinese text correctly; JSON stays plain UTF-8.

## Code map

- `apps/disco-ui/` — React browser application.
- `apps/disco-daemon/` — REST services, task admission, realtime events, auth,
  analytics, uploads, and workspace APIs.
- `apps/disco-cli/` — operational CLI.
- `packages/core/` — canonical types, database schemas/repositories, API client,
  configuration, and shared utilities.
- `packages/executor/` — isolated Codex execution and workspace provisioning.
- `packages/disco-codex/` — Codex integration package.
- `context/` — concise architecture and implementation notes.

Important starting points:

- Workspace provisioning: `packages/executor/src/commands/workspace.ts`
- Conversation creation: `apps/disco-daemon/src/register-routes.ts`
- Agent context loading: `packages/executor/src/sdk-handlers/codex/prompt-service.ts`
- Queue semantics: `context/concepts/task-queueing.md`
- Runtime lifecycle and Stop: `context/concepts/task-runtime-state.md`
- Frontend rules: `context/guidelines/frontend.md`
- Multitenancy: `context/concepts/multitenancy.md`

## Engineering rules

1. Reuse canonical types from `packages/core/src/types/`; do not redefine them.
2. Preserve tenant/user ownership through database, filesystem, cache, upload,
   executor, and realtime boundaries.
3. The filesystem access boundary is the account, not an agent or a session.
   Sessions owned by one user may read and write any other session, agent,
   memory, or skill under that same user's `worktrees/user-*` root. They must
   never inspect a sibling user's `worktrees/user-*` root; ordinary paths
   outside other users' roots remain available to the runtime.
4. A standalone session starts without `AGENTS.md`, personality, memory, or
   agent-skill injection. An agent session starts with that agent's persistent
   profile, memory and skills. This default context is the only isolation
   difference within one account; it is not a filesystem barrier.
5. Prompt admission is database-authoritative. Never decide “run vs queue” from
   a stale client-side session read.
6. Supplemental instructions modify the active Codex turn only; queued prompts
   create durable tasks and retain their order.
7. Use Ant Design and theme tokens for UI. Preserve keyboard operation,
   accessible names, visible focus, loading, disabled, and error states.
8. Read files before editing. Use focused tests first, then typecheck/build in
   proportion to risk.
9. Preserve uploads, accounts, pricing, and shared skill settings during
   migrations unless the user explicitly authorizes deleting them.
10. Keep deployment credentials and runtime user data outside this repository.

## Development and verification

```powershell
# Focused checks
pnpm --filter disco-ui test -- <test-file>
pnpm --filter @disco/executor test -- <test-file>
pnpm --filter @disco/core test -- <test-file>

# Repository-wide checks when preparing a deployment
pnpm typecheck
pnpm build

# Health checks
Invoke-WebRequest http://127.0.0.1:3030/health
```

Unit tests are not sufficient for UI changes. After a successful build, use the
public site as a real user: open a deep link, switch conversations, upload an
attachment, send/stop a task, add a supplemental instruction, queue a next
message, inspect Settings, and verify both light and dark themes at more than
one local display scale.

## Naming

All first-party product names, package scopes, environment variables, API
routes, tool prefixes, prompts, assets, docs, and operational scripts use
**Disco** / `disco`. Do not add compatibility aliases carrying the retired
product name. Provider names such as Codex and ChatGPT remain unchanged.
