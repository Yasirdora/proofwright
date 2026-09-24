# Proofwright — first version (v0.1) spec

*Approved by the owner on 2026-09-24 ("Approve, please proceed with highest level of professionalism"). Changes to this spec need the owner's approval; the decisions made while building it are in [DECISIONS.md](DECISIONS.md).*

Proofwright is an MCP server that works **with** a human tester. You ask in
plain words; it shows you what it understood, writes the test cases and the
Playwright tests, makes up the test data, runs everything, proves the tests can
actually catch bugs, and explains every result with evidence you can open.

You stay in charge: it never approves its own plan, never changes what a test
expects without your yes, and never calls something "done" without proof.

---

## 1. What makes it different

| Problem today | Proofwright |
|---|---|
| AI test tools write tests that pass — even when the app is broken | Every test it writes is **proven**: it breaks the app on purpose and checks the test notices. A test that can't fail is reported, not counted. |
| "The AI did something" — you can't see what or why | Every answer has the same three parts: **What I did · What I found · What I need from you.** Every finding links to its evidence: screenshot, trace, file and line. |
| Vague requests get guessed at | Your request becomes a **test plan in tester language** you read and approve first. What it couldn't work out is asked, not guessed. |
| Old failures and flaky tests drown the real news | Every run is compared with the last one: **new failure · still failing · fixed · flaky.** |
| Auto-"healing" hides real regressions | It proposes a fix and explains it. It never silently changes a locator or an expected result. |
| Tools that need their own jargon and config | Your words: requirement, test case, test, run, bug, flaky. No IDs to learn, no contract files. Works on a normal Playwright project. |

## 2. How a session goes

> **You:** check that coupon codes work at checkout

1. **Explore.** Proofwright opens the page and reads what is really there: the
   form fields and their rules (required, max length, formats), the buttons,
   the API calls the page makes, and which existing tests already touch it.
2. **Plan.** It writes a **test plan** from your words and those facts: the test
   cases (normal paths and edge cases), the data each needs, what it will *not*
   cover, and the open questions — e.g. *"Can a coupon be combined with a sale
   price?"* You answer, edit, and approve. Only you approve.
3. **Write.** It writes the Playwright tests from the approved plan — one test per
   test case, one step per plan step, tagged with the test case id — and checks
   them against the review rules (section 5) before running anything.
4. **Data.** It makes up the test data the plan needs: valid values, limits,
   empty, very long, special characters, other scripts (Arabic, Chinese, emoji),
   dates across time zones. Made-up only; seeded, so a failure can be replayed.
5. **Run.** It runs the tests and compares with the last run.
6. **Prove.** It breaks the app on purpose — the API returns an error, an empty
   list, bad data, or is slow — and shows which tests noticed. *"TC-003 still
   passes when the coupon service fails: it never checks the error message."*
7. **Explain.** For every failure: the step that failed, the screenshot, the
   trace, and the likely cause — **app bug · test bug · flaky · environment** —
   with the reasoning shown and what to do next.
8. **Report.** One page for you or your lead.

## 3. The tools (what your AI client can call)

Named after what you already do. Each returns *What I did · What I found · What
I need from you*.

| Tool | What it does |
|---|---|
| `explore` | Reads a page or flow: fields and their rules, actions, API calls, existing tests that cover it. Facts, not guesses. |
| `plan` | Saves the test plan the AI drafted from your request; checks every test case has steps, data and an expected result; lists open questions. Stays a **draft** until you approve. |
| `approve_plan` | Your approval, in your words. The only way a plan becomes approved. |
| `write_tests` | Writes the Playwright test file for an approved plan (test per case, `test.step` per step, `@TC-…` tags, locators by role/label from `explore`). |
| `test_data` | Generates seeded, made-up data sets for the plan's fields: valid, limits, invalid, other scripts, long, empty. |
| `review` | Checks test scripts — its own or a colleague's — with fixed rules (section 5). Same answer every time. |
| `run` | Runs tests (all, a file, a tag, or a test case), keeps traces and screenshots on failure, compares with the last run. |
| `explain` | Debugs one failure from its evidence and names the likely cause, showing the reasoning. |
| `prove` | Runs tests while breaking the app on purpose (section 6); reports which faults each test catches and which tests can't fail. |
| `report` | Writes the one-page summary. |

Plus an MCP **prompt**, `/proofwright`, that starts the guided session above
from one plain sentence — the "prompt engineer" step, done in the open.

## 4. Test cases — readable here, ready for Jira

Test cases live in your repo as Markdown, shaped like Xray and Zephyr manual
test steps (**Action · Data · Expected result**), so exporting them is a mapping,
not a rewrite:

```markdown
---
feature: Checkout coupons
request: "check that coupon codes work at checkout"   # your words, kept
status: draft                                         # draft → approved (by you)
jira: []                                              # Xray/Zephyr keys once exported
---

## TC-001 · A valid coupon lowers the total
Priority: high · Tags: @checkout @coupon · Test: tests/checkout-coupons.spec.ts

| # | Action | Data | Expected result |
|---|---|---|---|
| 1 | Add a product to the cart | "Blue mug", €12.00 | Cart shows 1 item, total €12.00 |
| 2 | Apply the coupon | SAVE10 | Total €10.80, "SAVE10 applied" shown |

## Open questions
1. Can a coupon be combined with a sale price?

## Not covered
- Real card payments (out of scope)
```

Everything Proofwright keeps is a plain file in a visible `proofwright/`
folder — plans, data, runs, reports — that you can read, edit and commit.

## 5. Review rules (v0.1)

Findings give file:line, why it matters, and the fix. No AI opinion — rules.

- Fixed waits (`waitForTimeout`) instead of waiting for a state
- A test with no assertion, or an `expect` without `await`
- `force: true` clicks that skip the checks a user would hit
- Fragile selectors (long CSS/XPath, `nth()` without reason) where a role or label exists
- `test.only` / `test.skip` left in
- Tests that depend on another test's leftovers or order
- Passwords, tokens or real-looking personal data written into a test
- Retries that hide a test failing every first try

## 6. How "prove" breaks the app (v0.1)

Without touching the app's code: Playwright's network control makes the API
calls a test depends on return **an error (500)**, **an empty result**,
**malformed data**, or **arrive slowly**. A good test fails (or shows the
right error) for each fault that matters to it.

*Limit in v0.1:* this works for tests written with Proofwright's small test
fixture (every test it writes uses it). Proving tests written without it —
your colleagues' existing suites — comes in v0.2, through a local proxy.

## 7. The demo app

**Proofwright Shop** — a small local web shop with its own API: products, cart,
coupon codes, sign-up and login (test accounts only), checkout with a validated
form. No framework, few dependencies, runs with one command.

It contains **planted bugs** (for example: a coupon applied twice on a double
click, an email check that accepts `a@b`, a total that rounds wrongly, a name in
Arabic that breaks the layout) and a small **"colleague's" test file** with
weak tests and review-rule violations — so we can measure Proofwright, not just
demo it. Honest limit: I write both the bugs and the tool, so the demo shows it
works; a real project of yours is the true test later.

## 8. Done means (how v0.1 is judged)

1. From three plain requests (*coupons at checkout*, *the sign-up form*, *the
   cart total*), it produces plans you can read in about two minutes each, with
   what it couldn't work out listed as questions.
2. Its tests pass on the parts that work and **fail on the planted bugs** —
   each failure explained with the right cause (app bug vs test bug).
3. `prove` catches the colleague's tests that can't fail.
4. `review` flags every planted rule violation and nothing on clean files.
5. Every result links to evidence you can open.
6. No real data, no passwords typed by the tool, nothing leaves your machine
   beyond what your AI client sends.

## 9. Not in v0.1 (next)

- **v0.2:** export test cases to Xray / Zephyr (import files); `prove` for any
  existing test via a local proxy; more review rules.
- **v0.3:** sync with Jira directly (your API token, set by you — Proofwright
  never asks for passwords); requirements coverage (each requirement → its tests
  → last result); API-only tests.
- Not planned: mobile apps, load testing, replacing Playwright's own agents —
  Proofwright uses Playwright; it doesn't compete with it.

## 10. How it will be built

- **Where:** a new local repo, `~/proofwright`. Not published anywhere until you say so.
- **Stack:** TypeScript on Node, the official MCP SDK, Playwright Test as the
  runner, the TypeScript compiler for the review rules. Few dependencies.
- **Milestones:** M0 demo shop and its planted bugs → M1 explore, plan,
  approve, write, data, review → M2 run, explain, report → M3 prove.
- **Process:** each milestone is scoped and approved by the owner before it's
  built.
