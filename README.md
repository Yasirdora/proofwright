# Proofwright

An MCP server that works **with** a human tester. You ask in plain words;
Proofwright shows you what it understood as a test plan you approve, writes the
test cases and the Playwright tests, makes up the test data, runs everything,
**proves** the tests can catch bugs by breaking the app on purpose, and explains
every result with evidence you can open.

It never approves its own plan, never changes what a test expects without your
yes, and never calls something done without proof.

- **Spec (approved):** [docs/SPEC.md](docs/SPEC.md)
- **Decisions made while building:** [docs/DECISIONS.md](docs/DECISIONS.md)

## Status

v0.1 is being built in milestones, each scoped and approved before it is built:

| Milestone | Contents | State |
|---|---|---|
| M0 | Proofwright Shop — the demo app, its planted bugs, a "colleague's" weak tests | in progress |
| M1 | `explore`, `plan`, `approve_plan`, `write_tests`, `test_data`, `review` | — |
| M2 | `run`, `explain`, `report` | — |
| M3 | `prove` | — |

Not published anywhere; local only.
