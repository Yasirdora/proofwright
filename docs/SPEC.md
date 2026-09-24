# Proofwright — first version (v0.1) spec

*Approved by the owner on 2026-09-24 ("Approve, please proceed with highest level of professionalism"). Re-scoped the same day to build on Playwright's own test agents instead of duplicating them ("I agree with you, please proceed…"). Changes to this spec need the owner's approval; the decisions made while building it are in [DECISIONS.md](DECISIONS.md).*

Proofwright is an MCP server that works **with** a human tester, alongside
Playwright's own test agents. Playwright's planner explores the app and drafts
a plan, and its generator writes the tests; Proofwright turns the plan into
test cases you approve, reviews every test before it counts, makes up the test
data, proves the tests can actually catch bugs, and explains every result with
evidence you can open. It doesn't rebuild what Playwright already does.

You stay in charge: it never approves its own plan, never changes what a test
expects without your yes, and never calls something "done" without proof.

---

## 1. What makes it different

| Problem today | Proofwright |
|---|---|
| AI test tools write tests that pass — even when the app is broken | Every test — whoever wrote it — is **proven**: Proofwright breaks the app on purpose and checks the test notices. A test that can't fail is reported, not counted. |
| "The AI did something" — you can't see what or why | Every answer has the same three parts: **What I did · What I found · What I need from you.** Every finding links to its evidence: screenshot, trace, file and line. |
| Vague requests get guessed at | Your request becomes a **test plan in tester language** you read and approve first. What it couldn't work out is asked, not guessed. |
| Old failures and flaky tests drown the real news | Every run is compared with the last one: **new failure · still failing · fixed · flaky.** |
| Auto-"healing" hides real regressions — Playwright's own healer is told to fix "assertions and expected values" until the test passes, without asking | It proposes a fix and explains it. It never changes a locator or an expected result without your yes. |
| Tools that need their own jargon and config | Your words: requirement, test case, test, run, bug, flaky. No IDs to learn, no contract files. Works on a normal Playwright project. |

## 2. How a session goes

> **You:** check that coupon codes work at checkout

1. **Explore and draft** — *Playwright's planner.* It opens the app, explores
   the flow, and drafts a plan: scenarios, steps, expected results.
2. **Test cases** — *Proofwright.* It turns the draft into **test cases in
   tester language** (Action · Data · Expected result), checks each has steps,
   data and an expected result, and lists what's still open — e.g. *"Can a
   coupon be combined with a sale price?"* You answer, edit, and approve. Only
   you approve; only approved cases go on.
3. **Write** — *Playwright's generator* writes a test per approved case; then
   *Proofwright* reviews every test against the review rules (section 5) before
   it counts.
4. **Data** — *Proofwright.* It makes up the test data the cases need: valid
   values, limits, empty, very long, special characters, other scripts (Arabic,
   Chinese, emoji), dates at the edges. Made-up only; seeded, so a failure can
   be replayed.
5. **Run** — *Playwright's runner.* Proofwright compares each run with the last:
   new failure · still failing · fixed · flaky.
6. **Prove** — *Proofwright.* It breaks the app on purpose — the API returns an
   error, an empty list, bad data, or is slow — and shows which tests noticed.
   *"TC-003 still passes when the coupon service fails: it never checks the
   error message."*
7. **Explain** — *Proofwright,* from Playwright's evidence. For every failure:
   the step that failed, the screenshot, the trace, and the likely cause —
   **app bug · test bug · flaky · environment** — with the reasoning shown and
   what to do next. It proposes; it never edits a test's expectations on its own.
8. **Report** — *Proofwright.* One page for you or your lead.

## 3. The tools (what your AI client can call)

**Proofwright's tools** — named after what you already do. Each returns *What I
did · What I found · What I need from you*.

| Tool | What it does | State |
|---|---|---|
| `review` | Checks test scripts — Playwright's generator's, yours or a colleague's — against the rules in section 5. Same answer every time. | done (M1a) |
| `test_data` | Seeded, made-up data for the cases' fields: valid, limits, invalid, other scripts, long, empty — each marked accept or refuse from your rules, or asked. | done (M1a) |
| `approve_plan` | Turns the planner's draft into test cases (section 4), shows what's open, and records your approval, in your words. The only way a case becomes approved. | M1b |
| `explain` | Diagnoses one failure from Playwright's evidence and names the likely cause, showing the reasoning. Proposes a fix; never applies one to an expectation without your yes. | M2 |
| `report` | The one-page summary, with every run compared to the last. | M2 |
| `prove` | Runs tests while breaking the app on purpose (section 6); reports which faults each test catches and which tests can't fail. | M3 |

Plus an MCP **prompt**, `/proofwright`, that runs the session above from one
plain sentence, calling Playwright's agents and Proofwright's tools in turn —
the "prompt engineer" step, done in the open.

**Used from Playwright, not rebuilt:** the planner and the generator
(`npx playwright init-agents`), and its test tools (`test_run`, `test_debug`,
`test_list`, the browser tools). The healer isn't used: it changes what tests
expect in order to pass them, which is exactly what Proofwright must not do.

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
Seven of them are checked through eslint-plugin-playwright's own rules; the
rest are Proofwright's. Only real Playwright test files are reviewed.

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

It has to work on **any** Playwright test — the ones Playwright's generator
writes, yours, your colleagues' — without editing them or your config: the
faults are applied around the run, never inside the test. How (a wrapper config
for the runner, a local proxy, or both) is settled with a spike when M3 is
scoped.

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
   cart total*), the planner's drafts become test cases you can read in about
   two minutes each, with what couldn't be worked out listed as questions.
2. The tests written from your approved cases pass on the parts that work and
   **fail on the planted bugs** — each failure explained with the right cause
   (app bug vs test bug).
3. `prove` catches the colleague's tests that can't fail.
4. `review` flags every planted rule violation and nothing on clean files.
5. Every result links to evidence you can open.
6. No real data, no passwords typed by the tool, nothing leaves your machine
   beyond what your AI client sends.

## 9. Not in v0.1 (next)

- **v0.2:** export test cases to Xray / Zephyr (import files); more review rules.
- **v0.3:** sync with Jira directly (your API token, set by you — Proofwright
  never asks for passwords); requirements coverage (each requirement → its tests
  → last result); API-only tests.
- Not planned: mobile apps, load testing, replacing Playwright's own agents —
  Proofwright uses Playwright; it doesn't compete with it.

## 10. How it will be built

- **Where:** a local repo, `~/proofwright`. Not published anywhere until you say so.
- **Stack:** TypeScript on Node, the official MCP SDK, Playwright Test and its
  agents for exploring, generating and running, eslint-plugin-playwright and the
  TypeScript compiler for the review rules. Few dependencies.
- **In a tester's project:** Playwright's agents once (`npx playwright
  init-agents --loop=claude`), and Proofwright's MCP server.
- **Milestones:** M0 demo shop and its planted bugs (done) → M1a the server,
  `review`, `test_data` (done) → M1b `approve_plan` and the `/proofwright`
  prompt → M2 `explain`, `report` → M3 `prove`.
- **Process:** each milestone is scoped and approved by the owner before it's
  built.
