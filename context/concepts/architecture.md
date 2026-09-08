# Architecture (cheat sheet for agents)

> User-facing reference: [`apps/disco-docs/pages/guide/architecture.mdx`](../../apps/disco-docs/pages/guide/architecture.mdx).
> Source of truth = the code. This file is a fast orientation map.

## Mental model

```
Clients (disco-cli | disco-ui | external SDK clients)
      │                          via Feathers client
      ▼
disco-daemon (FeathersJS server, REST + WS + JSON-RPC /mcp)
      │
      ├── Services (apps/disco-daemon/src/services/*)
      │     hooks: auth, validation, short-id resolution, RBAC
      │
      ├── Repositories (packages/core/src/db/repositories/*)
      │     thin Drizzle wrappers, return canonical types
      │
      ├── Drizzle ORM (packages/core/src/db/schema.{sqlite,postgres}.ts)
      │
      ├── Executor (packages/executor — subprocess-isolated agent runtime)
      │     spawns claude-code / codex / gemini SDK handlers
      │
      └── Storage:
            SQLite (LibSQL) at ~/.disco/disco.db          (default)
            PostgreSQL                                   (multi-tenant)
            Filesystem at ~/.disco/worktrees/<repo>/<wt> (git branches)
```

## Key decisions you'll bump into

- **API-first from day one.** CLI and UI both go through the daemon's Feathers API; nothing speaks to the DB directly. New features → service + repository + (maybe) CLI command.
- **Hybrid materialization.** Columns for fields you query/index by, JSON for everything else. Cross-dialect (SQLite + Postgres) — never write dialect-specific SQL outside `db/schema.*.ts`.
- **simple-git only.** No `execSync`/`spawn` for git. `packages/core/src/git/index.ts` is the single git wrapper.
- **WebSocket events** (`<service>:<created|patched|removed>`) are emitted by Feathers automatically; UI subscribes via `@disco/client` reactive helpers.
- **Executor isolation.** Agents run in `packages/executor` as a separate process tree, optionally as a different unix user (`unix_user_mode`). See `context/explorations/executor-isolation.md` for the design.
- **MCP self-access.** Daemon exposes `POST /mcp` so agents introspect Disco (sessions, branches, boards). Token-authenticated. Routes in `apps/disco-daemon/src/mcp/routes.ts`.

## Where to look first

| If you're touching...  | Open this                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Data model             | `packages/core/src/types/` + `packages/core/src/db/schema.{sqlite,postgres}.ts`                    |
| New service / endpoint | `apps/disco-daemon/src/services/` + `context/guides/extending-feathers-services.md`                 |
| Migrations             | `packages/core/drizzle/{sqlite,postgres}/` + `context/guides/creating-database-migrations.md`      |
| Git operations         | `packages/core/src/git/index.ts`                                                                   |
| Auth / RBAC            | `apps/disco-daemon/src/utils/branch-authorization.ts` + `context/guides/rbac-and-unix-isolation.md` |
| Agent runtime          | `packages/executor/` + `context/explorations/executor-isolation.md`                                |
| Task runtime state     | `context/concepts/task-runtime-state.md`                                                           |
| Real-time UI           | `packages/client/` reactive helpers + `apps/disco-ui/src/hooks/`                                    |
| MCP tools              | `apps/disco-daemon/src/mcp/routes.ts`                                                               |

## Tech stack (one-liner)

FeathersJS · Drizzle · LibSQL/SQLite · PostgreSQL · simple-git · React 18 + Vite · Ant Design · React Flow · oclif · pnpm/turborepo.
