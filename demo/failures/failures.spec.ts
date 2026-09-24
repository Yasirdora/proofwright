import { test, expect } from "@playwright/test";

/**
 * Failures of every kind, for measuring Proofwright's `explain` and `report`.
 * What each one really is — app bug, test bug, flaky, environment — is in
 * ../answer-key/FAILURES.md, which Proofwright never reads. Not part of
 * `npm test`: most of these fail on purpose.
 */

test("passes: the products page lists six products", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Products" }).getByRole("listitem")).toHaveCount(6);
});

test("SAVE10 on a notebook rounds to the nearest cent", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add Notebook to cart" }).click();
  await page.goto("/#/cart");
  await page.getByLabel("Coupon code").fill("SAVE10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("total")).toHaveText("€11.11", { timeout: 2_000 });
});

test("a quantity of -1 is refused", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add Blue mug to cart" }).click();
  const answer = await page.request.patch("/api/cart/items/blue-mug", { data: { qty: -1 } });
  expect(answer.status()).toBe(400);
});

test("adding to the cart updates the count", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Add .* to cart/ }).click({ timeout: 2_000 });
  await expect(page.getByRole("link", { name: "Cart (1)" })).toBeVisible();
});

test("applying a coupon shows the discount", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add Blue mug to cart" }).click();
  await page.goto("/#/cart");
  await page.getByLabel("Coupon code").fill("SAVE10");
  await page.getByRole("button", { name: "Apply coupon" }).click({ timeout: 2_000 });
  await expect(page.getByTestId("discount")).toHaveText("−€1.20");
});

test("the cart total is read from the summary", async ({ page }) => {
  await page.goto("/#/cart");
  const summary = (await page.getByTestId("total").count()) > 0 ? page.getByTestId("total") : undefined;
  // The cart is empty, so there is no summary — and the test never considered that.
  await expect(summary!.first()).toHaveText("€0.00");
});

test.describe("retried", () => {
  test.describe.configure({ retries: 1 });

  test("the header shows the shop's name", async ({ page }, testInfo) => {
    await page.goto("/");
    // Simulated flakiness: this check fails on the first attempt only.
    expect(testInfo.retry, "first attempt").toBeGreaterThan(0);
    await expect(page.getByRole("link", { name: "Proofwright Shop" })).toBeVisible();
  });
});

test("the stock service answers", async ({ page }) => {
  await page.goto("http://stock.invalid/levels");
});
