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

## 2026-09-24 · Build on Playwright's agents; don't rebuild them

Checked while building M1a, at the owner's prompt ("we do not want to build
something they already build"). Playwright 1.61 ships three agents —
planner, generator, healer (`npx playwright init-agents`) — over its own test
MCP server (`planner_save_plan`, `generator_write_test`, `test_run`,
`test_debug`, `browser_snapshot` …). The spec's `explore`, `plan`,
`write_tests` and `run` would duplicate them. The healer is the opposite of
Proofwright: its instructions say to fix "assertions and expected values", not
to ask the user, and to "do the most reasonable thing possible to pass the
test". The owner agreed to re-scope Proofwright as the trust layer on top of
those agents; the spec (docs/SPEC.md §1–3, §5, §6, §8–10) was re-scoped
accordingly on the owner's yes to the diff.

## 2026-09-24 · `review` reuses eslint-plugin-playwright for the rules it has

Seven of the thirteen review rules exist in eslint-plugin-playwright 2.12
(`no-wait-for-timeout`, `expect-expect`, `missing-playwright-await`,
`no-force-option`, `no-focused-test`, `no-skipped-test`, `no-raw-locators`,
`no-nth-methods`), so it checks them. Proofwright keeps only what it lacks:
tests that hand data to each other, serial mode, shared accounts, passwords
and real personal data in tests, retries — plus two gaps in the plugin: the
selector-string page API (`page.fill("input[name=…]")`) and `.fixme`.

- It runs through ESLint's `Linter` with an explicit configuration, so the
  tester's own ESLint setup is never read or changed and every project is
  reviewed the same way.
- The plugin's stricter meaning is adopted: any `.skip` left in is a finding,
  as is every raw CSS locator and `.first()`/`.nth()`. The review key
  (demo/answer-key/REVIEW.md) gained the colleague's lines 31 and 59.
- A skipped, empty test isn't also reported as "no assertion": the skip is the
  finding.
- Every finding names who found it — the plugin's rule, or Proofwright.

## 2026-09-24 · The MCP server uses the SDK's low-level `Server`

Tools are declared with hand-written JSON Schemas and inputs are checked by
hand, so no schema library appears in Proofwright's own code. Answers go out
as text (the three parts) plus the same result as structured content.

## 2026-09-24 · Runtime dependencies, and Node 20.19

`typescript` moved to the runtime dependencies (`review` parses test files with
it), next to `@modelcontextprotocol/sdk`, `eslint`, `eslint-plugin-playwright`
and `@typescript-eslint/parser`, all pinned. ESLint 10 needs Node 20.19 or
newer, so `engines` says so. `npm audit` found nothing. The one install script
in the tree, `fsevents` (Playwright's optional macOS file-watcher, used only by
its watch/UI modes), stays unapproved: nothing here needs it.

## 2026-09-24 · `test_data` marks only what the rules decide

An expectation (accept/refuse) comes only from the rules the tester gives, plus
three documented defaults — email shaped like name@domain.tld, phone numbers of
6–15 digits, dates written YYYY-MM-DD — each named in the answer. When no rule
decides (is the field required? should spaces be trimmed? does 1e2 count?), the
value is marked for the tester and the question is asked. Every value is made
up: invented names, reserved email domains (example.com, example.org, .test),
phone numbers from ranges set aside for fiction (Ofcom's 07700 900xxx, the
US 555-01xx). The seed defaults to 1; each field draws from its own stream, so
adding a field never changes the others.

## 2026-09-24 · A fixed password in a test is always a finding

The rule is strict — any literal typed into a password field — rather than
guessing whether a sign-up form makes it harmless. The shop's own tests typed
fixed passwords into three sign-up tests, against their helper's promise that
passwords are "never written into a test"; they now generate one per run
(`newPassword()`), and the rule stays strict.

## 2026-09-24 · `review` reads only Playwright test files

A `*.test.ts` file isn't necessarily a Playwright test: projects keep Jest,
Vitest and node:test suites next to their Playwright specs. Reviewing this
repository whole flagged Proofwright's own node:test unit tests 34 times. A file
now counts only if it really imports `@playwright/test` (or `playwright/test`),
itself or through a local module such as a fixtures file — read with the
TypeScript compiler's import scanner, so text inside strings never counts. The
rest are left out, and named in the answer.

## 2026-09-24 · M1b: `approve_plan` works on Playwright's own plan format

The plan Playwright's planner saves (`specs/*.md`) is the source; Proofwright's
test cases (`proofwright/cases/<name>.md`, Action · Data · Expected result)
are generated from it, never edited by hand — change the plan, run
`approve_plan` again. Case numbers are stable across re-plans. An approval is
tied to a fingerprint of its case: if the plan changes the case, the approval
lapses. Approved cases are written back in Playwright's own plan format
(`specs/<name>.approved.md`), each title starting with its case number, so
Playwright's generator reads it like any plan and every test traces to its case.
A contract test runs Playwright's real `planner_save_plan` and requires the
reader to read it exactly and the writer to write it byte for byte — a
Playwright release that changes the format fails that test.

A case with no expected result anywhere can't be approved (it could never
fail). Unclear steps — a value typed but not named, "works as expected" —
are questions; approving accepts them as they are.

## 2026-09-24 · The approval comes from the tester

When the app can show a form (MCP elicitation — Claude Code in the terminal,
from 2.1.76; not yet the desktop app, anthropics/claude-code#41110),
Proofwright asks the tester directly and the AI's words are ignored. Otherwise
it needs the tester's own words, passed verbatim, and records that they were
relayed by the AI client. That second path is only as honest as the client.

## 2026-09-24 · `/proofwright`, and where the agents start

The prompt names each step, who does it, and where the tester decides. The
project's `proofwright/config.json` can name the Playwright project, seed test
and tests folder for the agents: measured, Playwright's planner uses the first
project in the config by default and fails with "seed test not found" when the
seed lives elsewhere. The demo names project `generated`.

## 2026-09-24 · `proofwright init` protects the project's MCP servers

Measured: `npx playwright init-agents` replaces `.mcp.json`, dropping every
other MCP server in it. `init` reads the file first and puts those servers
back, and says which. It shows its changes and makes them only with `--yes`.
Playwright also installs its healer agent; `init` says Proofwright never uses
it, and leaves the choice to delete it to the tester.

## 2026-09-24 · The demo carries Playwright's planner and generator — not the healer

`.claude/agents/` holds the two agent files Playwright's `init-agents` wrote
(1.61.1); the healer's is left out on purpose. `.mcp.json` registers Playwright's
test server and Proofwright (`node dist/src/cli.js mcp`, relative to the repo).
Generated tests go to `demo/generated/`, a Playwright project of its own that
`npm test` leaves out — they meet the planted bugs. Its seed test checks the
products page, so review stays clean.

## 2026-09-24 · M2: `report` runs Playwright's runner; it doesn't rebuild it

A run is `npx playwright test` with the project's own config; Proofwright adds
only the JSON reporter (to `PLAYWRIGHT_JSON_OUTPUT_FILE`) and
`--trace=retain-on-failure`. Or it reads a JSON report the tester already has,
from CI. Playwright's `test_run` MCP tool answers in text for an agent to read;
there is nothing in it to keep and compare, which is why `report` asks the
runner for its JSON report instead.

Each run is kept in `proofwright/runs/<id>/` with every failure's evidence
copied beside it — the screenshot, `error-context.md` (Playwright's error
details and the page's accessibility snapshot at the failure) and the trace
(up to 20 MB) — because Playwright clears `test-results/` on its next run.
`proofwright/runs/` stays out of git; the reports (`proofwright/reports/`) are
meant to be kept. `proofwright init` now adds the `.gitignore` entry too.

## 2026-09-24 · How `explain` decides, and how sure it says it is

Fixed rules, strongest evidence first: a pass on retry is **flaky**; an address
that doesn't resolve or refuses, or a browser that won't start, is
**environment**; the test's own `TypeError`/`ReferenceError` and a strict-mode
violation are **test bugs** — all "certain". A locator that found nothing is
judged from the page snapshot: an element of the same kind with a close name
means the locator is out of date (**test bug**, "likely"); nothing like it means
the element is missing (**app bug**, "possible"); the exact element present but
unusable is **unclear**. A value the page showed that the test didn't expect is
an **app bug** — "likely" when an approved test case set the expectation,
otherwise "possible", with the note that the requirement decides; a test that
passed before on the same code drops to "possible", flagged as maybe flaky.

It never proposes changing what a test expects to make it pass; for an app bug
it drafts the bug report, pointing at the test case when there is one.

## 2026-09-24 · A failure suite with an answer key

`demo/failures/` fails on purpose, one test per kind: two planted app bugs
(B3, B7), three test bugs (strict mode, a stale button name, a `TypeError`), a
flaky test and an unreachable service — `stock.invalid`, a reserved name that
can never resolve (port 9 was tried first; Chrome refuses it as an unsafe port,
which isn't the failure meant). The flaky test is simulated — it fails on its
first attempt only — and says so. `demo/answer-key/FAILURES.md` holds the
answers; an integration test requires `report` to match them, on a copy of the
demo and a port of its own. The suite is a Playwright project of its own, out of
`npm test`.
