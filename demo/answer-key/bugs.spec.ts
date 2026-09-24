import { test, expect } from "@playwright/test";
import { addToCart, applyCoupon, signUp, summary } from "../tests/helpers";

/**
 * The answer key: one test per planted bug (BUGS.md). Each asserts what the
 * shop PROMISES (demo/README.md) and is marked test.fail(), so it passes while
 * the bug is there. If a bug disappears, its test turns red — the answer key
 * must change with it.
 *
 * Proofwright never reads this folder when it explores, plans or writes tests.
 */

test.describe("planted bugs", () => {
  test("B1 · applying the same coupon twice (double-click) discounts once", { tag: "@B1" }, async ({ page }) => {
    test.fail();
    await addToCart(page, "Blue mug");
    await page.goto("/#/cart");
    await page.getByLabel("Coupon code").fill("SAVE10");
    await page.getByRole("button", { name: "Apply" }).dblclick();
    await expect(summary(page)).toContainText("Discount (SAVE10)");
    await expect(summary(page).getByTestId("discount")).toHaveText("−€1.20", { timeout: 2_000 });
    await expect(summary(page).getByTestId("total")).toHaveText("€10.80", { timeout: 2_000 });
  });

  test("B2 · an email without a domain ending is refused", { tag: "@B2" }, async ({ page }) => {
    test.fail();
    await page.goto("/#/signup");
    await page.getByLabel("Full name").fill("Ada Lovelace");
    await page.getByLabel("Email").fill("ada@example");
    await page.getByLabel("Password", { exact: true }).fill("engine1843");
    await page.getByLabel("Confirm password").fill("engine1843");
    await page.getByLabel("Date of birth").fill("1990-12-10");
    const answer = page.waitForResponse((r) => r.url().endsWith("/api/signup"));
    await page.getByRole("button", { name: "Create account" }).click();
    // The direct evidence first: the shop must refuse to create this account.
    expect((await answer).status(), "sign-up with ada@example").toBe(400);
    await expect(page.getByLabel("Email")).toHaveAccessibleDescription("Enter a valid email address");
  });

  test("B3 · a percentage discount rounds to the nearest cent", { tag: "@B3" }, async ({ page }) => {
    test.fail();
    await addToCart(page, "Notebook"); // €12.35 — 10% is 123.5 cents, which rounds to 124
    await page.goto("/#/cart");
    await applyCoupon(page, "SAVE10");
    await expect(summary(page).getByTestId("total")).toHaveText("€11.11", { timeout: 2_000 });
  });

  test("B4 · the thank-you shows the full name exactly as entered", { tag: "@B4" }, async ({ page }) => {
    test.fail();
    await signUp(page);
    await addToCart(page, "Pencil set");
    await page.goto("/#/checkout");
    await page.getByLabel("Full name").fill("Zoë Ångström-李小龍");
    await page.getByLabel("Address").fill("1 Harbour Road");
    await page.getByLabel("Postal code").fill("D02 X285");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Thank you, Zoë Ångström-李小龍!", {
      timeout: 2_000,
    });
  });

  test("B5 · WELCOME5 works on an order of exactly €20.00", { tag: "@B5" }, async ({ page }) => {
    test.fail();
    await addToCart(page, "Tea sampler"); // exactly €20.00
    await page.goto("/#/cart");
    await applyCoupon(page, "WELCOME5");
    await expect(summary(page).getByTestId("total")).toHaveText("€15.00", { timeout: 2_000 });
  });

  test("B6 · an order that can't be placed shows the reason, not a thank-you", { tag: "@B6" }, async ({ page }) => {
    test.fail();
    await signUp(page);
    await addToCart(page, "Limited poster"); // 3 in stock
    await page.goto("/#/cart");
    const qty = page.getByLabel("Quantity for Limited poster");
    await qty.fill("5");
    await qty.blur();
    await expect(summary(page).getByTestId("total")).toHaveText("€40.00");
    await page.goto("/#/checkout");
    await page.getByLabel("Address").fill("1 Harbour Road");
    await page.getByLabel("Postal code").fill("D02 X285");
    await page.getByRole("button", { name: "Place order" }).click();
    // Wait until the page has reacted — an error, or a thank-you — then judge it.
    await expect(page.getByRole("alert").or(page.getByRole("heading", { name: /Thank you/ }))).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Checkout");
    await expect(page.getByRole("alert")).toHaveText("Only 3 left of Limited poster");
  });

  test("B7 · a negative quantity is refused and the cart does not change", { tag: "@B7" }, async ({ page }) => {
    test.fail();
    await addToCart(page, "Blue mug");
    await page.goto("/#/cart");
    const qty = page.getByLabel("Quantity for Blue mug");
    const answer = page.waitForResponse((r) => r.url().includes("/api/cart/items/"));
    await qty.fill("-1");
    await qty.blur();
    // The direct evidence first: the shop must refuse the quantity.
    expect((await answer).status(), "quantity −1").toBe(400);
    await expect(page.getByRole("row").filter({ hasText: "Blue mug" })).toContainText("€12.00");
    await expect(page.getByRole("status")).toHaveText("Choose a quantity from 1 to 99");
  });
});
