# Decisions

Choices made while building v0.1 that the spec leaves open. Newest last. A
decision that changes what the spec promises goes to the owner first.

## 2026-09-24 · TypeScript 5.9, not 7

TypeScript 7 (the native rewrite) is current on npm, but its compiler API is not
the classic JavaScript API the `review` rules (M1) are built on. 5.9.3 is stable
and has it. Revisit when 7's API settles.

## 2026-09-24 · The demo shop is plain JavaScript, type-checked

Proofwright Shop is modern JavaScript (ES modules) with no build step and no
framework, so it runs with one command — as the spec asks. It is still
type-checked: `// @ts-check` in every file and `tsc --checkJs` in `npm run check`.
The MCP server itself (M1 on) is TypeScript.

## 2026-09-24 · Playwright 1.61.1, pinned

1.63 is current, but it needs a Chromium build (1243) this machine doesn't have —
a ~150 MB download. 1.61.1 uses the Chromium already installed (1228), which
another project here uses too. Upgrading is one version bump plus
`npx playwright install chromium`, whenever the owner wants it.

## 2026-09-24 · The shop runs on port 4610, and tests never reuse a server

Vite dev servers take ports from 5173 upward; while building M0, eDraft's dev
server was on 5199 and an early check hit it instead of the shop. 4610 is outside
those ranges, and `reuseExistingServer: false` makes a busy port fail loudly
instead of testing the wrong app.

## 2026-09-24 · The answer key is executable, and off limits to Proofwright

Each planted bug has a test that asserts the shop's promise and is marked
`test.fail()`: it passes while the bug is there and turns red if the bug
disappears, so the key can't drift from the app. Its failure messages show
the bug directly (−€2.40 for −€1.20, a 201 where a 400 is required). The
answer key and the colleague's review key live in `demo/answer-key/`, which
Proofwright must never read while it explores, plans, writes or reviews;
M1's tools enforce that with an ignore list.
