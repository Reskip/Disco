# Marketing screenshot staging

This folder contains demo-only screenshots for `disco.live` landing-page / homepage visuals.

## Demo route

The UI fixture lives at:

```txt
/demo/marketing-screenshots
```

It is intentionally hardcoded and daemon-free. `apps/disco-ui/src/App.tsx` short-circuits this explicit route before auth, client, or live workspace data hooks mount, so the fake state cannot leak into normal production workspace paths. The staging fixture uses the real `AppHeader`, `GlobalPresenceFacepile`/`Facepile`, `SessionCanvas`, zones, branch cards, generic cards, markdown notes, and spatial comments. Only the things that are hard to produce deterministically for screenshots — multiple logged-in users and their remote cursors — are injected through explicit `staticActiveUsers` / `staticCursors` demo props.

## What it renders

- Product navbar via `AppHeader`, including board switcher, search, connection state, comments badge, and user menu
- Product facepile behavior via `GlobalPresenceFacepile` / `Facepile` with 12 fixed demo users; normal max/overflow behavior is preserved unless explicitly overridden
- Product board via `SessionCanvas`, with real zone nodes, branch cards, generic cards, markdown notes, and a spatial comment
- Product cursor rendering via `RemoteCursorLayer` with fixed demo cursor positions

## Captured files

- `context/marketing/screenshots/disco-marketing-board.png` — 1600×1000 crop for quick previews
- `context/marketing/screenshots/disco-marketing-board-wide.png` — 2200×1300 wide hero composition
- `context/marketing/screenshots/disco-marketing-comment-popover.png` — close crop of spatial comment + branch card
- `context/marketing/screenshots/disco-marketing-facepile-tooltip.png` — close crop of facepile overflow/tooltip behavior
- `context/marketing/screenshots/disco-marketing-social-comment-context.png` — contextual spatial comment crop used in the docs multiplayer section
- `context/marketing/screenshots/disco-marketing-social-comment-closeup.png` — alternate tight spatial comment crop
- `context/marketing/screenshots/disco-marketing-cursor-indicator.png` — live cursor label closeup for collage layering
- `context/marketing/screenshots/disco-marketing-slack-thread.png` — Slack Message Gateway thread used for docs feature cards/pages
- Public docs copies:
  - `apps/disco-docs/public/screenshots/marketing/disco-marketing-board.png`
  - `apps/disco-docs/public/screenshots/marketing/disco-marketing-board-wide.png`
  - `apps/disco-docs/public/screenshots/marketing/disco-marketing-comment-popover.png`
  - `apps/disco-docs/public/screenshots/marketing/disco-marketing-facepile-tooltip.png`
  - `apps/disco-docs/public/screenshots/marketing/disco-marketing-social-comment-context.png`
  - `apps/disco-docs/public/screenshots/marketing/disco-marketing-social-comment-closeup.png`
  - `apps/disco-docs/public/screenshots/marketing/disco-marketing-cursor-indicator.png`
  - `apps/disco-docs/public/screenshots/marketing/disco-marketing-slack-thread.png`

## Reproduce/update

From the repo root:

```bash
pnpm install --frozen-lockfile
# If packages/client/dist is missing in a fresh worktree, run this in a temp terminal
# and stop it after Vite starts successfully:
pnpm --filter @disco-live/client dev

pnpm --filter disco-ui dev --host 127.0.0.1 --port 5173

mkdir -p context/marketing/screenshots apps/disco-docs/public/screenshots/marketing
```

Open `http://127.0.0.1:5173/demo/marketing-screenshots` and wait a few seconds for
the embedded Sandpack artifact to render before capturing. The committed board
screenshots were captured with Playwright/browser tooling after a 10s wait:

```js
await page.setViewportSize({ width: 1600, height: 1000 });
await page.goto('http://127.0.0.1:5173/demo/marketing-screenshots', {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(10000);
await page.screenshot({ path: 'context/marketing/screenshots/disco-marketing-board.png' });

await page.setViewportSize({ width: 2200, height: 1300 });
await page.goto('http://127.0.0.1:5173/demo/marketing-screenshots', {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(10000);
await page.screenshot({ path: 'context/marketing/screenshots/disco-marketing-board-wide.png' });
```

Then mirror the landing-page assets:

```bash
cp context/marketing/screenshots/disco-marketing-board*.png \
  apps/disco-docs/public/screenshots/marketing/
```

Raw Chrome headless also works for quick static checks, but it may snapshot
before the Sandpack artifact iframe has painted:

```bash
google-chrome --headless --disable-gpu --no-sandbox \
  --window-size=1600,1000 --hide-scrollbars --virtual-time-budget=5000 \
  --screenshot=context/marketing/screenshots/disco-marketing-board.png \
  http://127.0.0.1:5173/demo/marketing-screenshots

google-chrome --headless --disable-gpu --no-sandbox \
  --window-size=2200,1300 --hide-scrollbars --virtual-time-budget=5000 \
  --screenshot=context/marketing/screenshots/disco-marketing-board-wide.png \
  http://127.0.0.1:5173/demo/marketing-screenshots

cp context/marketing/screenshots/disco-marketing-board*.png \
  apps/disco-docs/public/screenshots/marketing/
```

The Chrome DBus warnings in headless Linux are harmless if the PNG is written.
