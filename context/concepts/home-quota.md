# Home quota

The compact home strip shows only the primary Codex bucket's weekly remaining
percentage and reset time. It deliberately omits plan, other buckets, reset
credits, update timestamps, and a details menu.

Authenticated clients read `GET /codex-quota` (Feathers `find`). The service is
available only in the local shared-credential deployment; separately routed
tenant credentials never fall back to the host account. The public response
contains only `status`, `remainingPercent`, and `resetsAt`.

The daemon queries `account/rateLimits/read` through a short-lived native
`codex app-server --listen stdio://` process. `DISCO_HOST_CODEX_HOME` selects the
host login directory, falling back to the daemon user's `.codex`. It must not
point to a separate Disco runtime login when the host quota is intended.
`DISCO_CODEX_QUOTA_COMMAND` optionally selects the native Codex executable;
Windows installs exposing only a `.cmd` shim must set this to `codex.exe`.
No login token is extracted and no reset, login, or thread method is called.

The main `codex` bucket in `rateLimitsByLimitId` is authoritative. Legacy
`rateLimits` is used only when grouped data is absent. A duration of 10080 minutes
identifies the weekly window regardless of its primary/secondary position.
Missing data remains unavailable rather than implying zero usage or remaining
quota. Reset timestamps are Unix seconds from Codex; the home label uses Beijing
time to match the approved design.

One in-flight read is shared by simultaneous requests; successful data is cached
for up to 60 seconds and never beyond its reset time. Failures back off for 30
seconds. Visible home pages refresh once a minute and on focus. No quota request
blocks rendering of the greeting, navigation, or Token dashboard.

Protocol reference: https://developers.openai.com/codex/app-server#rate-limits-chatgpt
