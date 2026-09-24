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
| M1b | `approve_plan` and the `/proofwright` prompt — on Playwright's own planner and generator | — |
| M2 | `explain` and `report` — on Playwright's runner and its evidence | — |
| M3 | `prove` — on any Playwright test | — |

Not published anywhere; local only.

## The tools

| Tool | What it does |
|---|---|
| `review` | Checks Playwright test scripts — yours or a colleague's — against 13 rules: fixed waits, tests with no assertion, `expect` without `await`, forced clicks, fragile selectors, `.only`/`.skip` left in, tests that hand data to each other, run-in-order mode, shared accounts, passwords or real personal data in tests, and retries that hide flaky tests. Seven of the rules are checked through [eslint-plugin-playwright](https://github.com/mskelton/eslint-plugin-playwright); the rest are Proofwright's own. Every finding says which one found it. Reads only; runs and changes nothing. |
| `test_data` | Made-up values for a form's fields — typical, at the limits, invalid, and the unusual ones that break apps (other scripts, right-to-left, emoji, markup, byte limits) — each marked **accept**, **refuse**, or a question for you, worked out only from the rules you give. Same seed, same values. Can save to `proofwright/data/<name>.json`. |

## Use it with Claude Code

Needs Node 20.19 or newer.

```sh
npm install
npm run build
claude mcp add proofwright -- node /path/to/proofwright/dist/src/cli.js mcp
```

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
```

What the shop promises, its API, and why it has planted bugs:
[demo/README.md](demo/README.md).
