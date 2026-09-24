# Proofwright Shop

A small local web shop that Proofwright is built and measured against. It has
products, a cart, coupon codes, sign-up and log-in, and a checkout — enough for
realistic tests, small enough to read in one sitting.

```sh
npm run shop          # http://127.0.0.1:4610
npm test              # the shop's own tests + the answer key
```

> **This app contains planted bugs on purpose.** They are how Proofwright is
> measured. Do not fix them. They are listed in
> [answer-key/BUGS.md](answer-key/BUGS.md), and each one has a test there that
> passes only while the bug is present.
>
> Proofwright must not read `answer-key/` when it explores, plans or writes
> tests — that folder is the marking scheme, not a hint.

## What the shop promises

These are the requirements a tester tests against. Where the shop breaks one,
that's a bug.

### Products
- Every product shows its name and price. A product on sale shows the sale
  price, and the old price as "was €…".
- A product with 5 or fewer left says "Only N left".
- "Recommended for you" shows three products within 2 seconds.

### Cart
- "Add to cart" adds one of the product; the cart count in the header updates.
- A quantity is a whole number from 1 to 99. Anything else is refused with
  "Choose a quantity from 1 to 99", and the cart does not change.
- "Remove" takes the product out. An empty cart says "Your cart is empty."

### Coupons
- One coupon per order. Applying the coupon that is already applied changes
  nothing; applying a different one replaces it.
- **SAVE10** — 10% off the subtotal. Percentages are rounded to the nearest cent
  (a half cent rounds up).
- **WELCOME5** — €5.00 off an order of **€20.00 or more**. Below that: "Spend at
  least €20.00 to use this coupon".
- **SPRING24** — expired: "This coupon has expired".
- Any other code: "This coupon code isn't valid".
- Coupons apply to the whole subtotal, sale prices included.

### Accounts
- Sign-up needs: a name (up to 60 characters), an email address shaped like
  `name@domain.tld`, a password of at least 8 characters with a letter and a
  number, the same password again, and a date of birth — you must be 18 or
  older.
- Each problem is shown next to its field. An email that already has an account:
  "An account with this email already exists".
- Log-in with a wrong email or password: "Email or password is incorrect".

### Checkout
- Only a logged-in customer with a non-empty cart can check out.
- Shipping needs a full name (up to 60 characters), an address and a postal code;
  a phone number is optional.
- If there isn't enough stock, the order is not placed and the page says so:
  "Only N left of …". It never shows a thank-you for an order that wasn't placed.
- After a successful order: "Thank you, *full name*!" with the full name exactly
  as entered (up to 60 characters, in any script), the order number (`PW-…`) and
  the total paid.

## API

| Method | Path | Does |
|---|---|---|
| GET | `/api/health` | `{ ok: true, app: "proofwright-shop" }` |
| GET | `/api/products` | All products |
| GET | `/api/recommendations` | Three products (answers in 0–1.5 s) |
| GET | `/api/cart` | The cart: lines, count, coupon, subtotal, discount, total (cents) |
| POST | `/api/cart/items` | `{ productId, qty? }` — add |
| PATCH | `/api/cart/items/:productId` | `{ qty }` — change the quantity (0 removes) |
| DELETE | `/api/cart/items/:productId` | Remove |
| POST / DELETE | `/api/cart/coupon` | `{ code }` — apply / remove the coupon |
| POST | `/api/signup` | `{ name, email, password, confirmPassword, birthDate }` |
| POST | `/api/login` · `/api/logout` | Log in / out |
| GET | `/api/me` | `{ user }` or `{ user: null }` |
| POST | `/api/orders` | `{ shipping: { fullName, address, postalCode, phone? } }` |
| GET | `/api/orders/:id` | One of your orders |

Errors are `{ error, fields? }` with a 4xx status. The session is a cookie; all
state is in memory and resets when the server restarts.

## Folders

| Folder | What |
|---|---|
| `shop/` | The app: `server.mjs` (HTTP + API), `store.mjs` (rules and state), `public/` (the page) |
| `tests/` | The shop's own tests — everything that works, works |
| `answer-key/` | The planted bugs and the review findings, with a test for each bug |
| `colleague/` | A colleague's weak tests, for Proofwright's `review` and `prove` tools. Not part of `npm test` |
