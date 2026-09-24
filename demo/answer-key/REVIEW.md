# The colleague's tests — the review key

`demo/colleague/` is a colleague's quick smoke tests: realistic, mostly green,
and full of the problems Proofwright's `review` rules (spec §5) must flag — and
that its `prove` tool must expose. Line numbers are exact; if a file changes,
this key changes with it.

**Proofwright must not read this folder** when it reviews or proves tests.

## Review findings (`review`, spec §5)

`review` checks seven of these rules through eslint-plugin-playwright, and the
rest with its own checks; every finding names which one found it.

| Rule | File:line | What |
|---|---|---|
| Fixed waits | `checkout.spec.ts:17`, `:39` | `waitForTimeout(2000)` / `(1000)` instead of waiting for a state |
| A test with no assertion | `checkout.spec.ts:9` ("user can sign up"), `:20` ("add to cart works") | They click and never check anything |
| `expect` without `await` | `checkout.spec.ts:46` | The thank-you check is never awaited, so it never checks |
| Forced click | `checkout.spec.ts:30` | `click({ force: true })` skips the checks a real user would hit |
| Fragile selectors | `checkout.spec.ts:22`; `:11`–`:16`; `:31`; `:59` | A `#app > ul > li:nth-child(1)` chain; `input[name=…]` and `text=` where labels and roles exist; raw `locator("body")` and `locator("li")`, and `.first()` |
| `test.only` / `test.skip` left in | `wip.spec.ts:3`, `:8` | `.only` narrows every run to one test; `.skip` switches a test off, with no condition and no reason |
| Tests that depend on each other | `checkout.spec.ts:5`, `:7`, `:35`–`:37`, `:50` | A module-level `orderNumber`, serial mode, a log-in that needs the account an earlier test created, and a test that only reads another test's result |
| Passwords written into a test | `checkout.spec.ts:13`, `:14`, `:37` | `"Winter2026!"` |
| Retries hiding a failing first try | `checkout.spec.ts:55` (with `:59`) | `retries: 2` around a test whose 800 ms timeout is shorter than the 2 s the shop promises — it fails on and off, and retries hide it |

Clean files for the "nothing on clean files" check: everything in `demo/tests/`.

## Tests that can't fail (`prove`, spec §6)

| Test | File:line | Why it can't fail |
|---|---|---|
| "coupon works" | `checkout.spec.ts:25` | Its only check is that `<body>` is visible — it passes if the coupon API errors, or the discount is wrong |
| "add to cart works" | `checkout.spec.ts:20` | No check at all |
| "checkout" | `checkout.spec.ts:34` | Its thank-you check is not awaited (`:46`); it passes as long as the text `Order PW-…` appears |
