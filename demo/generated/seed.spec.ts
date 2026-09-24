import { test, expect } from "@playwright/test";

// Playwright's planner and generator start every session from this test:
// Proofwright Shop, opened fresh, with an empty cart.
test.describe("Proofwright Shop", () => {
  test("seed", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
  });
});
