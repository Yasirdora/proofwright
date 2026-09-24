import { test, expect } from "@playwright/test";

test.only("sign-up page opens", async ({ page }) => {
  await page.goto("/#/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
});

test.skip("password rules", async () => {});
