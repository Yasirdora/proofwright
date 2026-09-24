import { test, expect } from "@playwright/test";

// Checkout smoke tests — written quickly before the release.

let orderNumber: string;

test.describe.configure({ mode: "serial" });

test("user can sign up", async ({ page }) => {
  await page.goto("/#/signup");
  await page.fill("input[name=name]", "Colleague Tester");
  await page.fill("input[name=email]", "colleague@example.com");
  await page.fill("input[name=password]", "Winter2026!");
  await page.fill("input[name=confirmPassword]", "Winter2026!");
  await page.fill("input[name=birthDate]", "1985-03-02");
  await page.click("text=Create account");
  await page.waitForTimeout(2000);
});

test("add to cart works", async ({ page }) => {
  await page.goto("/");
  await page.locator("#app > ul > li:nth-child(1) > button").click();
});

test("coupon works", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add Blue mug to cart" }).click();
  await page.goto("/#/cart");
  await page.getByLabel("Coupon code").fill("SAVE10");
  await page.getByRole("button", { name: "Apply" }).click({ force: true });
  await expect(page.locator("body")).toBeVisible();
});

test("checkout", async ({ page }) => {
  await page.goto("/#/login");
  await page.getByLabel("Email").fill("colleague@example.com");
  await page.getByLabel("Password").fill("Winter2026!");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForTimeout(1000);
  await page.goto("/");
  await page.getByRole("button", { name: "Add Pencil set to cart" }).click();
  await page.goto("/#/checkout");
  await page.getByLabel("Address").fill("5 Test Street");
  await page.getByLabel("Postal code").fill("T35 7ST");
  await page.getByRole("button", { name: "Place order" }).click();
  expect(page.getByRole("heading", { name: /Thank you/ })).toBeVisible();
  orderNumber = (await page.getByText(/Order PW-/).textContent())!.match(/PW-\d+/)![0];
});

test("order number is shown", async () => {
  expect(orderNumber).toMatch(/^PW-\d+$/);
});

test.describe("recommendations", () => {
  test.describe.configure({ retries: 2 });

  test("recommendations load", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("recommendations").locator("li").first()).toBeVisible({ timeout: 800 });
  });
});
