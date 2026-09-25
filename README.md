# Proofwright

An MCP server that works **with** a human tester on Playwright tests. It is the
trust layer next to Playwright's own agents: Playwright explores, writes and
runs; Proofwright checks what they — and people — produce, makes the test data,
proves tests can catch bugs, and never changes what a test expects without the
tester's yes.

Every answer is short and in plain English, in the same order — **the result,
what to do, what was done** — with details only where something needs
explaining, so it can go to a developer as it is. Every finding links to its
file and line.

- **Spec (approved):** [docs/SPEC.md](docs/SPEC.md)
- **Decisions made while building:** [docs/DECISIONS.md](docs/DECISIONS.md)

## Status

| Milestone | Contents | State |
|---|---|---|
| M0 | Proofwright Shop — the demo app, its planted bugs, a "colleague's" weak tests | done |
| M1a | The MCP server with `review` and `test_data` | done |
| M1b | `approve_plan`, the `/proofwright` prompt and `proofwright init` — on Playwright's own planner and generator | done |
| M2 | `report` and `explain` — on Playwright's runner and its evidence | done |
| M3 | `prove` — on any Playwright test | done |

Not published anywhere; local only.

## The tools

| Tool | What it does |
|---|---|
| `review` | Checks Playwright test scripts — yours or a colleague's — against 13 rules: fixed waits, tests with no assertion, `expect` without `await`, forced clicks, fragile selectors, `.only`/`.skip` left in, tests that hand data to each other, run-in-order mode, shared accounts, passwords or real personal data in tests, and retries that hide flaky tests. Seven of the rules are checked through [eslint-plugin-playwright](https://github.com/mskelton/eslint-plugin-playwright); the rest are Proofwright's own. Every finding says which one found it. Reads only; runs and changes nothing. |
| `approve_plan` | Turns the plan Playwright's planner saved into numbered test cases you read — Action · Data · Expected result — asks about what's open (a step that doesn't say what it types, a vague result, a result the requirements don't promise), and records your approval case by case. Only approved cases go on, in a plan of their own for Playwright's generator. The approval is yours: where the app can show a form (Claude Code in the terminal), Proofwright asks you directly — **Accept** approves, **Decline** doesn't, and the form waits 15 minutes; elsewhere it needs your own words. Cases you leave out aren't asked about again. |
| `report` | The one-page report. Runs Playwright's own runner (your config, plus a JSON report and traces on failure) — or reads a JSON report from CI — keeps the results and every failure's evidence, compares with the run before (new failures, still failing, fixed), and gives each failure a one-line diagnosis with how sure it is. |
| `explain` | One failure in depth: the failing line, expected and received, the page as it was, the screenshot and trace, the reasoning — **app bug, test bug, flaky or environment** — and what to do, with a bug report drafted for an app bug. It proposes; it never changes a test, and never proposes changing what a test expects to make it pass. |
| `prove` | Proves tests can fail: runs them with the app broken on purpose and shows which notice. A clean run first learns which API calls each test's steps make; then each call fails in turn (a server error, or empty lists), every answer comes late once, and — for a step a test repeats — the answers to the repeat come late and different. A test that stays green while its own step fails, or that checks the page before its step's answers arrive, needs a better check: the answer names the step and line (`"Apply" (coupons.spec.ts:30)`) with a screenshot of the page it passed on. Works on any Playwright test through a temporary config beside yours; your tests and config aren't changed. Takes minutes: one run per call broken. |
| `test_data` | Made-up values for a form's fields — typical, at the limits, invalid, and the unusual ones that break apps (other scripts, right-to-left, emoji, markup, byte limits) — each marked **accept**, **refuse**, or a question for you, worked out only from the rules you give. Same seed, same values. Can save to `proofwright/data/<name>.json`. |

Plus the prompt **`/proofwright`** (in Claude Code: `/mcp__proofwright__proofwright`):
one plain sentence runs the whole session — Playwright's planner drafts, you
approve the test cases, Playwright's generator writes only the approved ones,
`review` checks them, and `prove` shows whether they can fail. Playwright's
healer is never used.

## Set up your own Playwright project

Needs Node 20.19 or newer.

```sh
npm install && npm run build          # in this repository, once
node /path/to/proofwright/dist/src/cli.js init          # in your project: shows what it would change
node /path/to/proofwright/dist/src/cli.js init --yes    # …and does it
```

`init` installs Playwright's agents (`npx playwright init-agents --loop=claude`),
adds Proofwright's MCP server next to Playwright's in `.mcp.json`, and creates
`proofwright/config.json`. Playwright's `init-agents` replaces `.mcp.json`
outright; `init` puts your other MCP servers back.

## Try the whole flow on the demo shop (about 5 minutes)

```sh
npm install && npm run build
claude          # Claude Code in this folder; allow the two project MCP servers it offers
```

Then, in Claude Code:

```
/mcp__proofwright__proofwright check that coupon codes work at checkout
```

Playwright's planner explores the shop and saves a plan in `specs/`; Proofwright
shows the test cases and what's open; you approve (in a form, in the terminal
app — in your own words elsewhere); Playwright's generator writes the approved
tests into `demo/generated/`; Proofwright reviews them, then proves them (a few
minutes: it runs them with the shop's API broken on purpose). Then run
`npm run test:generated` — some should fail on the shop's planted coupon bugs.
Ask *"report on the generated tests"* and *"explain the first failure"*: `report`
runs them through Playwright and names each failure; `explain` shows why. Don't
start the shop yourself: Playwright starts it on port 4610 when it needs it.

To see `report` and `explain` on failures of every kind — app bugs, test bugs,
a flaky test, an unreachable service — without the agents:

```sh
node dist/src/cli.js report --project failures
node dist/src/cli.js explain "applying a coupon"
```

(`demo/answer-key/FAILURES.md` says what each failure really is.)

To see `prove` on a colleague's weak tests — three of them pass when the very
thing they test fails (about four minutes):

```sh
node dist/src/cli.js prove demo/colleague/checkout.spec.ts --project colleague
```

(`demo/answer-key/REVIEW.md` has the verdicts it should give;
`npm run accept:prove` checks them.)

## From a terminal

The server works on the project Claude Code is running in; a tool call can
name another with `root`. Or from a terminal:

```sh
node dist/src/cli.js review demo/colleague      # the three-part answer
node dist/src/cli.js review demo/colleague --json
node dist/src/cli.js prove tests/checkout.spec.ts --endpoint "POST /api/orders"   # break only that call
```

`prove` breaks only what the browser (and Playwright's request fixture)
receives, not calls between servers. It needs `openssl` for HTTPS; without it,
HTTPS calls pass through unbroken and the answer says so. It's measured on
Chromium. A config that sets its own proxy isn't supported yet.

`proofwright/config.json` in a project lists paths Proofwright must never read
(this repo keeps the demo's answer key out that way), and can name the files
that say what the app promises — `"requirements": ["docs/requirements.md"]`
(this repo: `demo/README.md`). Expected results come from those and from you,
never from the app's code.

## Try the demo shop

```sh
npm run shop     # Proofwright Shop on http://127.0.0.1:4610
npm test         # Proofwright's unit tests, then the shop's tests and the answer key
npm run check    # type-check everything
npm run test:generated   # the tests Playwright's generator wrote, if any
npx playwright test --project=failures   # the failures built for explain and report
```

What the shop promises, its API, and why it has planted bugs:
[demo/README.md](demo/README.md).
