# Coupon codes at checkout — Proofwright Shop

## Application Overview

Proofwright Shop is a small local web shop (products, cart, coupons, accounts, checkout). This plan centres on coupon codes: that SAVE10, WELCOME5, SPRING24 and unknown codes behave as demo/README.md promises in the cart (discount shown, replacement rules, thresholds, rounding, sale prices), and that whatever discount a coupon gives is correctly reflected in the total the customer actually pays at checkout and on the order confirmation. Every test starts from a completely fresh browser context (no cookies, empty cart, logged out) and builds whatever state it needs itself — a fresh account is signed up with a made-up, unique email where login is required. Product catalogue observed directly on the Products page: Blue mug €12.00, Notebook €12.35, Desk lamp €29.90 (was €39.90, on sale), Limited poster €8.00 (Only 3 left), Tea sampler €20.00, Pencil set €4.50.

## Test Scenarios

### 1. Coupon codes in the cart

**Seed:** `demo/generated/seed.spec.ts`

#### 1.1. 1. SAVE10 takes 10% off the subtotal

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Click "Add to cart" on Blue mug (€12.00).
    - expect: The header cart link reads "Cart (1)".
  2. Go to the cart page.
    - expect: The Blue mug row shows €12.00.
    - expect: The order summary shows Subtotal €12.00 and Total €12.00 with no discount line.
  3. In the Coupon code field, type SAVE10 and click Apply.
    - expect: A confirmation message "SAVE10 applied." appears.
    - expect: The order summary now shows a "Discount (SAVE10)" line reading −€1.20.
    - expect: The Total line reads €10.80.

#### 1.2. 2. WELCOME5 takes €5 off an order above the €20.00 minimum

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug (€12.00) and Tea sampler (€20.00) to the cart.
    - expect: The header cart link reads "Cart (2)".
  2. Go to the cart page.
    - expect: The order summary shows Subtotal €32.00.
  3. Type WELCOME5 into the Coupon code field and click Apply.
    - expect: A confirmation message "WELCOME5 applied." appears.
    - expect: The order summary shows a "Discount (WELCOME5)" line reading −€5.00.
    - expect: The Total line reads €27.00.

#### 1.3. 3. WELCOME5 is refused just below the €20.00 minimum

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Pencil set (€4.50) to the cart.
    - expect: The header cart link reads "Cart (1)".
  2. Go to the cart page and change the quantity for Pencil set to 4.
    - expect: The order summary shows Subtotal €18.00.
  3. Type WELCOME5 into the Coupon code field and click Apply.
    - expect: An error message reading "Spend at least €20.00 to use this coupon" is shown.
    - expect: The order summary shows no discount line.
    - expect: The Total line still reads €18.00.

#### 1.4. 4. WELCOME5 is accepted at exactly the €20.00 minimum

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Tea sampler (€20.00) to the cart.
    - expect: The header cart link reads "Cart (1)".
  2. Go to the cart page.
    - expect: The order summary shows Subtotal €20.00 and Total €20.00.
  3. Type WELCOME5 into the Coupon code field and click Apply. (demo/README.md promises WELCOME5 for "an order of €20.00 or more", so a €20.00 subtotal should qualify.)
    - expect: A confirmation message "WELCOME5 applied." appears — no "Spend at least €20.00" error.
    - expect: The order summary shows a "Discount (WELCOME5)" line reading −€5.00.
    - expect: The Total line reads €15.00.

#### 1.5. 5. SAVE10 rounds a half-cent discount up to the next cent

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Notebook (€12.35) to the cart.
    - expect: The header cart link reads "Cart (1)".
  2. Go to the cart page.
    - expect: The order summary shows Subtotal €12.35.
  3. Type SAVE10 into the Coupon code field and click Apply. (10% of €12.35 is €1.235, a half cent that demo/README.md says rounds up.)
    - expect: The order summary shows a "Discount (SAVE10)" line reading −€1.24.
    - expect: The Total line reads €11.11.

#### 1.6. 6. SAVE10 discounts a sale-priced product's sale price

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Confirm Desk lamp shows €29.90 with "was €39.90", then click "Add to cart" on it.
    - expect: The header cart link reads "Cart (1)".
  2. Go to the cart page.
    - expect: The Desk lamp row shows €29.90.
    - expect: The order summary shows Subtotal €29.90.
  3. Type SAVE10 into the Coupon code field and click Apply.
    - expect: The order summary shows a "Discount (SAVE10)" line reading −€2.99 (10% of the €29.90 sale price, not the €39.90 original price).
    - expect: The Total line reads €26.91.

#### 1.7. 7. WELCOME5 counts a sale-priced product's sale price toward its minimum

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Click "Add to cart" on Desk lamp (shown at €29.90, was €39.90).
    - expect: The header cart link reads "Cart (1)".
  2. Go to the cart page.
    - expect: The order summary shows Subtotal €29.90.
  3. Type WELCOME5 into the Coupon code field and click Apply.
    - expect: A confirmation message "WELCOME5 applied." appears.
    - expect: The order summary shows a "Discount (WELCOME5)" line reading −€5.00.
    - expect: The Total line reads €24.90.

#### 1.8. 8. SPRING24 is refused as an expired coupon

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug to the cart and go to the cart page.
    - expect: The order summary shows Subtotal €12.00.
  2. Type SPRING24 into the Coupon code field and click Apply.
    - expect: An error message reading "This coupon has expired" is shown.
    - expect: The order summary shows no discount line and the Total still reads €12.00.

#### 1.9. 9. An unrecognized coupon code is refused

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug to the cart and go to the cart page.
    - expect: The order summary shows Subtotal €12.00.
  2. Type a made-up code, NOPE, into the Coupon code field and click Apply.
    - expect: An error message reading "This coupon code isn't valid" is shown.
    - expect: The order summary shows no discount line and the Total still reads €12.00.

#### 1.10. 10. Submitting the coupon form with no code is refused

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug to the cart and go to the cart page.
    - expect: The Coupon code field is empty and the order summary shows Total €12.00.
  2. Leave the Coupon code field empty and click Apply.
    - expect: An error message reading "This coupon code isn't valid" is shown.
    - expect: The order summary shows no discount line and the Total still reads €12.00.

#### 1.11. 11. A very long, made-up coupon code is refused without breaking the page

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug to the cart and go to the cart page.
    - expect: The order summary shows Total €12.00.
  2. Type a long, made-up code of about 300 repeated letters (e.g. "A" repeated) into the Coupon code field and click Apply.
    - expect: An error message reading "This coupon code isn't valid" is shown.
    - expect: The page still renders normally: the cart table, coupon form and order summary (Total €12.00) are all still visible and usable.

#### 1.12. 12. A coupon code is recognized in lower case and with extra spaces

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug to the cart and go to the cart page.
    - expect: The order summary shows Total €12.00.
  2. Type "  save10  " (lower case, with leading and trailing spaces) into the Coupon code field and click Apply.
    - expect: A confirmation message "SAVE10 applied." appears (the code is shown upper-case).
    - expect: The order summary shows a "Discount (SAVE10)" line reading −€1.20 and the Total reads €10.80.

#### 1.13. 13. Applying a different coupon replaces the one already applied

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Desk lamp (€29.90) to the cart and go to the cart page.
    - expect: The order summary shows Subtotal €29.90.
  2. Type SAVE10 into the Coupon code field and click Apply.
    - expect: The order summary shows "Discount (SAVE10)" −€2.99 and Total €26.91.
  3. Type WELCOME5 into the Coupon code field and click Apply.
    - expect: A confirmation message "WELCOME5 applied." appears.
    - expect: The order summary now shows "Discount (WELCOME5)" −€5.00 and no longer mentions SAVE10 anywhere.
    - expect: The Total reads €24.90.

#### 1.14. 14. Re-applying the coupon that's already applied leaves the discount unchanged

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug (€12.00) to the cart and go to the cart page.
    - expect: The order summary shows Subtotal €12.00.
  2. Type SAVE10 into the Coupon code field and click Apply.
    - expect: The order summary shows "Discount (SAVE10)" −€1.20 and Total €10.80.
  3. Type SAVE10 into the Coupon code field again (the exact same code already applied) and click Apply. (demo/README.md promises this "changes nothing".)
    - expect: The order summary still shows a single "Discount (SAVE10)" line reading −€1.20, unchanged from before.
    - expect: The Total still reads €10.80.

#### 1.15. 15. An unrecognized code entered while a valid coupon is applied does not remove the existing discount

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug (€12.00) to the cart and go to the cart page.
    - expect: The order summary shows Subtotal €12.00.
  2. Type SAVE10 into the Coupon code field and click Apply.
    - expect: The order summary shows "Discount (SAVE10)" −€1.20 and Total €10.80.
  3. Type a made-up code, NOPE, into the Coupon code field and click Apply.
    - expect: An error message reading "This coupon code isn't valid" is shown.
    - expect: The order summary still shows "Discount (SAVE10)" −€1.20 and Total €10.80 — the existing coupon is still applied.

#### 1.16. 16. An expired code entered while a valid coupon is applied does not remove the existing discount

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug (€12.00) to the cart and go to the cart page.
    - expect: The order summary shows Subtotal €12.00.
  2. Type SAVE10 into the Coupon code field and click Apply.
    - expect: The order summary shows "Discount (SAVE10)" −€1.20 and Total €10.80.
  3. Type SPRING24 into the Coupon code field and click Apply.
    - expect: An error message reading "This coupon has expired" is shown.
    - expect: The order summary still shows "Discount (SAVE10)" −€1.20 and Total €10.80 — the existing coupon is still applied.

#### 1.17. 17. Emptying the cart and adding a product back keeps the previously applied coupon in effect

**File:** `demo/generated/coupons-cart.spec.ts`

**Steps:**
  1. Start at the Products page with an empty cart. Add Blue mug (€12.00) to the cart and go to the cart page.
    - expect: The order summary shows Subtotal €12.00.
  2. Type SAVE10 into the Coupon code field and click Apply.
    - expect: The order summary shows "Discount (SAVE10)" −€1.20 and Total €10.80.
  3. Click Remove on the Blue mug row (there is no separate "remove coupon" control in this shop).
    - expect: The page shows "Your cart is empty." and a "Browse products" link.
  4. Go back to the Products page and add Blue mug to the cart again, then return to the cart page.
    - expect: Without re-entering any coupon code, the order summary already shows a "Discount (SAVE10)" line reading −€1.20 and the Total reads €10.80.

### 2. Coupon discounts carried through checkout

**Seed:** `demo/generated/seed.spec.ts`

#### 2.1. 18. A SAVE10 discount carries through to the amount paid at checkout

**File:** `demo/generated/coupons-checkout.spec.ts`

**Steps:**
  1. Sign up a fresh account from the Products page: full name "Priya Sharma", a unique made-up email (e.g. priya.tester+<random>@example.com), password "Password1", confirm the same password, and a date of birth that makes the account holder well over 18 (e.g. 1990-05-15). Submit the form.
    - expect: The header now shows "Hi, Priya Sharma" and a Log out button.
  2. Add Blue mug (€12.00) to the cart, go to the cart page, type SAVE10 into the Coupon code field and click Apply.
    - expect: The order summary shows "Discount (SAVE10)" −€1.20 and Total €10.80.
  3. Click "Go to checkout".
    - expect: The Checkout page shows the Full name field pre-filled with "Priya Sharma", and a line reading "Total to pay: €10.80".
  4. Fill in Address with "12 Fern Grove" and Postal code with "D01 AB12", leave Phone blank, then click "Place order".
    - expect: A confirmation page appears with the heading "Thank you, Priya Sharma!", a line reading "Order PW-… is placed." with a real order number, and a line reading "Total paid: €10.80" — matching the discounted total, not the €12.00 subtotal.

#### 2.2. 19. A WELCOME5 discount on a sale-priced item carries through to the amount paid at checkout

**File:** `demo/generated/coupons-checkout.spec.ts`

**Steps:**
  1. Sign up a fresh account from the Products page: full name "Sam Okafor", a unique made-up email, password "Password1", confirm the same password, and a date of birth well over 18 (e.g. 1988-01-01). Submit the form.
    - expect: The header now shows "Hi, Sam Okafor" and a Log out button.
  2. Add Desk lamp (shown at €29.90, was €39.90) to the cart, go to the cart page, type WELCOME5 into the Coupon code field and click Apply.
    - expect: The order summary shows "Discount (WELCOME5)" −€5.00 and Total €24.90.
  3. Click "Go to checkout".
    - expect: The Checkout page shows a line reading "Total to pay: €24.90".
  4. Fill in Address with "7 Birch Lane" and Postal code with "T12 F5R2", then click "Place order".
    - expect: A confirmation page appears with the heading "Thank you, Sam Okafor!", an order number PW-…, and a line reading "Total paid: €24.90".

#### 2.3. 20. Replacing one coupon with another before checkout updates the amount actually paid

**File:** `demo/generated/coupons-checkout.spec.ts`

**Steps:**
  1. Sign up a fresh account from the Products page: full name "Nora Byrne", a unique made-up email, password "Password1", confirm the same password, and a date of birth well over 18 (e.g. 1995-06-20). Submit the form.
    - expect: The header now shows "Hi, Nora Byrne" and a Log out button.
  2. Add Desk lamp (€29.90 sale price) to the cart, go to the cart page, type SAVE10 into the Coupon code field and click Apply.
    - expect: The order summary shows "Discount (SAVE10)" −€2.99 and Total €26.91.
  3. Type WELCOME5 into the Coupon code field and click Apply, replacing SAVE10.
    - expect: The order summary shows "Discount (WELCOME5)" −€5.00 (no mention of SAVE10) and Total €24.90.
  4. Click "Go to checkout".
    - expect: The Checkout page shows a line reading "Total to pay: €24.90" — the WELCOME5 amount, not the earlier SAVE10 amount.
  5. Fill in Address with "3 Cedar Court" and Postal code with "C15 K9P0", then click "Place order".
    - expect: A confirmation page appears with the heading "Thank you, Nora Byrne!" and a line reading "Total paid: €24.90".

#### 2.4. 21. Logging in from the checkout gate keeps the coupon discount and completes the order at the discounted total

**File:** `demo/generated/coupons-checkout.spec.ts`

**Steps:**
  1. Sign up a fresh account from the Products page: full name "Leo Fischer", a unique made-up email, password "Password1", confirm the same password, and a date of birth well over 18 (e.g. 1992-03-11). Submit the form, then click "Log out".
    - expect: The header shows "Sign up" and "Log in" links again (logged out).
  2. While logged out, add Desk lamp (€29.90 sale price) to the cart, go to the cart page, type WELCOME5 into the Coupon code field and click Apply.
    - expect: The order summary shows "Discount (WELCOME5)" −€5.00 and Total €24.90.
  3. Click "Go to checkout".
    - expect: The Checkout page shows "Log in to check out." with a "Log in" link, instead of a shipping form — the order is not placed.
  4. Click the "Log in" link on the checkout page, then enter the email and password used to sign up as Leo Fischer and click "Log in".
    - expect: You are returned to the Checkout page.
    - expect: The Checkout page now shows the shipping form with a line reading "Total to pay: €24.90" — the discount is unchanged from before logging in.
  5. Fill in Address with "9 Maple Street" and Postal code with "E22 W3X4", then click "Place order".
    - expect: A confirmation page appears with the heading "Thank you, Leo Fischer!", an order number PW-…, and a line reading "Total paid: €24.90".
