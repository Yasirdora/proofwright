# Failures — the answer key for `explain` and `report`

`demo/failures/failures.spec.ts` fails on purpose, one test per kind of
failure a tester meets. Proofwright is measured on naming each one right —
and on saying how sure it is. **Proofwright must not read this folder.**

| Test | What it really is | Why |
|---|---|---|
| "passes: the products page lists six products" | — (passes) | |
| "SAVE10 on a notebook rounds to the nearest cent" | **App bug** (planted bug B3) | The total element is there and shows €11.12; the shop promises €11.11 |
| "a quantity of -1 is refused" | **App bug** (planted bug B7) | The API answers 200 where the shop promises a refusal (400) |
| "adding to the cart updates the count" | **Test bug** | `getByRole('button', { name: /Add .* to cart/ })` matches all six products' buttons (strict mode) |
| "applying a coupon shows the discount" | **Test bug** | The test looks for a button named "Apply coupon"; the page's button is "Apply" |
| "the cart total is read from the summary" | **Test bug** | The test's own code throws a TypeError on an empty cart |
| "the header shows the shop's name" | **Flaky** (simulated) | Fails on its first attempt only, passes on the retry |
| "the stock service answers" | **Environment** | `stock.invalid` can never resolve — the service isn't reachable, whatever the app does |

A good explanation shows the evidence it decided from (the error, the page at
the moment of failure, the screenshot or trace) and never proposes changing
what a test expects to make it pass.
