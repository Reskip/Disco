/**
 * Claude-Code-specific constants for the executor's SDK handler.
 *
 * Sibling of `models.ts`. Anything that's a static configuration of the
 * Claude Agent SDK invocation (and not derived per-session) belongs here.
 */

/**
 * Built-in Claude Agent SDK tools that don't fit Disco's execution model.
 *
 * Disco sessions run non-interactively — there's no TTY, no shell-bound user,
 * and (in gateway channels like Slack) no UI to render an inline prompt. Tools
 * that require synchronous user interaction or can replace the current
 * session workspace have to be removed from the model's context entirely.
 *
 * - `AskUserQuestion`: blocks the executor waiting for an out-of-band answer.
 *   Hangs silently in Slack (#1177); the agent should inline its A/B/C
 *   choices in normal text and let the user reply as a new turn.
 * - `ExitPlanMode`: only meaningful inside Claude Code's interactive
 *   plan-mode UX. Disco doesn't expose plan-mode approval; the agent should
 *   produce plans as text in its response.
 * - `EnterWorktree` / `ExitWorktree`: Disco owns the current Session working
 *   directory. Letting the provider replace it mid-run would detach later
 *   operations from the Session's persisted workspace.
 * - `ScheduleWakeup`: a Claude Code CLI feature for the `/loop` skill
 *   (self-paced recurring tasks). Relies on the CLI harness to wake the
 *   conversation at a future time, which doesn't exist when Disco invokes
 *   claude-code through the Agent SDK — the model would call it, get a
 *   confirmation, then never be woken. Disco schedules are managed in the
 *   web UI and are intentionally not exposed as Agent methods.
 *
 * Passed to the SDK via `Options.disallowedTools`, which removes the named
 * tools from the model's context. The list is unioned with whatever
 * `~/.claude/settings.json`'s `permissions.deny` already contains, so
 * user customizations are preserved.
 */
export const CLAUDE_CODE_DISALLOWED_TOOLS = [
  'AskUserQuestion',
  'ExitPlanMode',
  // External Claude Code CLI tool names; do not rename with Disco domain terminology.
  'EnterWorktree',
  'ExitWorktree',
  'ScheduleWakeup',
] as const satisfies readonly string[];
