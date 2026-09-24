import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

/** A made-up password that meets the shop's rules — different on every run, never written into a test. */
export function newPassword(): string {
  return `pw-${randomUUID()}-1a`;
}

/**
 * A fresh account for one test, signed up through the API so the page's
 * cookies are logged in. The email and password are made up per test — never
 * a real credential, never written into a test.
 */
export async function signUp(page: Page, name = "Ada Lovelace") {
  const email = `tester+${randomUUID()}@example.com`;
  const password = newPassword();
  const res = await page.request.post("/api/signup", {
    data: { name, email, password, confirmPassword: password, birthDate: "1990-05-17" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return { name, email, password };
}

/** Add one of a product from the products page and wait for the confirmation. */
export async function addToCart(page: Page, product: string) {
  await page.goto("/");
  await page.getByRole("button", { name: `Add ${product} to cart` }).click();
  await expect(page.getByRole("status")).toHaveText(`${product} added to your cart.`);
}

/** Apply a coupon on the cart page. */
export async function applyCoupon(page: Page, code: string) {
  await page.getByLabel("Coupon code").fill(code);
  await page.getByRole("button", { name: "Apply" }).click();
}

export const summary = (page: Page) => page.getByRole("region", { name: "Order summary" });
