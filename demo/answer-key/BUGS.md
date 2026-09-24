# Planted bugs — the answer key

Proofwright Shop breaks seven of its own promises (../README.md) on purpose.
Proofwright is measured on how many it finds from plain requests, and whether
it names the right cause. Each bug has a test in [bugs.spec.ts](bugs.spec.ts)
that asserts the promise and is marked `test.fail()`: green while the bug is
there, red if it disappears.

**Proofwright must not read this folder** when it explores, plans or writes
tests.

| ID | Area | The promise | What actually happens | Where it lives |
|---|---|---|---|---|
| B1 | Coupons | Applying the coupon already applied changes nothing | Double-clicking **Apply** applies SAVE10 twice: −€2.40 instead of −€1.20 on a €12.00 mug. The button doesn't wait, and the server stacks a repeated code | `store.mjs` `applyCoupon` · `app.js` Apply handler |
| B2 | Sign-up | Email shaped like `name@domain.tld` | `ada@example` (no domain ending) creates an account | `store.mjs` `signUp` — the email pattern |
| B3 | Coupons | Percentages round to the nearest cent | 10% of €12.35 is 123.5 cents; the shop rounds down, so the total is €11.12, not €11.11 | `store.mjs` `discountCents` — `Math.floor` |
| B4 | Checkout | The thank-you shows the full name exactly, up to 60 characters, any script | Names are cut to 24 **bytes**: `Zoë Ångström-李小龍` becomes `Zoë Ångström-李小�` (a character cut in half); a long Latin name loses its end | `store.mjs` `clip` |
| B5 | Coupons | WELCOME5 works on orders of €20.00 or more | Exactly €20.00 is refused ("Spend at least €20.00…") — the check is "more than", not "at least" | `store.mjs` `applyCoupon` — the minimum check |
| B6 | Checkout | An order that isn't placed is never thanked for | Ordering 5 of a product with 3 in stock: the server refuses (409, "Only 3 left of Limited poster"), but the page shows "Thank you! Your order is placed." | `app.js` checkout submit — only a 400 is treated as an error |
| B7 | Cart | Quantities are 1–99; anything else is refused and the cart doesn't change | Typing −1 is accepted: the line becomes −€12.00 and the total €0.00 | `store.mjs` `setQuantity` — no lower bound |

## What a good find looks like

A find counts when Proofwright's report (a) shows the failing step with its
evidence (screenshot, trace, the value it expected and the one it got), and (b)
names the cause as an **app bug**, not a test bug, flaky or environment.

B6 is the one a normal run can miss: the server is right and only the page is
wrong. B1 needs a double-click, B3 a price whose tenth ends in a half cent,
B4 a name outside plain Latin letters, B5 an order of exactly the minimum —
each is an edge case a thorough plan should reach on its own.
