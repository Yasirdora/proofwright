# Proofwright

An MCP server that works **with** a human tester on Playwright tests. It is the
trust layer next to Playwright's own agents: Playwright explores, writes and
runs; Proofwright checks what they — and people — produce, makes the test data,
proves tests can catch bugs, and never changes what a test expects without the
tester's yes.

Every answer has the same three parts — **What I did · What I found · What I
need from you** — and every finding links to its file and line.

- **Spec (approved):** [docs/SPEC.md](docs/SPEC.md)
- **Decisions made while building:** [docs/DECISIONS.md](docs/DECISIONS.md)

## Status

| Milestone | Contents | State |
|---|---|---|
| M0 | Proofwright Shop — the demo app, its planted bugs, a "colleague's" weak tests | done |
| M1a | The MCP server with `review` and `test_data` | done |
| M1b | `approve_plan`, the `/proofwright` prompt and `proofwright init` — on Playwright's own planner and generator | done |
| M2 | `explain` and `report` — on Playwright's runner and its evidence | — |
| M3 | `prove` — on any Playwright test | — |

Not published anywhere; local only.

## The tools

| Tool | What it does |
|---|---|
| `review` | Checks Playwright test scripts — yours or a colleague's — against 13 rules: fixed waits, tests with no assertion, `expect` without `await`, forced clicks, fragile selectors, `.only`/`.skip` left in, tests that hand data to each other, run-in-order mode, shared accounts, passwords or real personal data in tests, and retries that hide flaky tests. Seven of the rules are checked through [eslint-plugin-playwright](https://github.com/mskelton/eslint-plugin-playwright); the rest are Proofwright's own. Every finding says which one found it. Reads only; runs and changes nothing. |
| `approve_plan` | Turns the plan Playwright's planner saved into numbered test cases you read — Action · Data · Expected result — lists what's open, and records your approval case by case. Only approved cases go on, in a plan of their own for Playwright's generator. The approval is yours: Proofwright asks you directly where the app can show a form (Claude Code in the terminal), and otherwise needs your own words. |
| `test_data` | Made-up values for a form's fields — typical, at the limits, invalid, and the unusual ones that break apps (other scripts, right-to-left, emoji, markup, byte limits) — each marked **accept**, **refuse**, or a question for you, worked out only from the rules you give. Same seed, same values. Can save to `proofwright/data/<name>.json`. |

Plus the prompt **`/proofwright`** (in Claude Code: `/mcp__proofwright__proofwright`):
one plain sentence runs the whole session — Playwright's planner drafts, you
approve the test cases, Playwright's generator writes only the approved ones,
and `review` checks them. Playwright's healer is never used.

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
tests into `demo/generated/`; Proofwright reviews them. Then run
`npm run test:generated` — some should fail on the shop's planted coupon bugs;
explaining those failures is the next milestone. Don't start the shop yourself:
Playwright starts it on port 4610 when it needs it.

## From a terminal

The server works on the project Claude Code is running in; a tool call can
name another with `root`. Or from a terminal:

```sh
node dist/src/cli.js review demo/colleague      # the three-part answer
node dist/src/cli.js review demo/colleague --json
```

`proofwright/config.json` in a project lists paths Proofwright must never read
(this repo keeps the demo's answer key out that way).

## Try the demo shop

```sh
npm run shop     # Proofwright Shop on http://127.0.0.1:4610
npm test         # Proofwright's unit tests, then the shop's tests and the answer key
npm run check    # type-check everything
npm run test:generated   # the tests Playwright's generator wrote, if any
```

What the shop promises, its API, and why it has planted bugs:
[demo/README.md](demo/README.md).
