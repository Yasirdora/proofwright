import { test, expect } from "@playwright/test";
import { addToCart, applyCoupon, signUp, summary } from "./helpers";

/**
 * The shop's own tests: every rule in demo/README.md that the shop keeps. The
 * rules it breaks on purpose are in ../answer-key/ instead.
 */

test.describe("products", () => {
  test("lists every product with its price", async ({ page }) => {
    await page.goto("/");
    const products = page.getByRole("list", { name: "Products" }).getByRole("listitem");
    await expect(products).toHaveCount(6);
    await expect(products.filter({ hasText: "Blue mug" })).toContainText("€12.00");
  });

  test("a product on sale shows the sale price and the old price", async ({ page }) => {
    await page.goto("/");
    // Scoped to the Products list: "Recommended for you" lists the lamp too, once it loads.
    const lamp = page.getByRole("list", { name: "Products" }).getByRole("listitem").filter({ hasText: "Desk lamp" });
    await expect(lamp).toContainText("€29.90");
    await expect(lamp).toContainText("was €39.90");
  });

  test("a product with few left says how many", async ({ page }) => {
    await page.goto("/");
    const poster = page.getByRole("list", { name: "Products" }).getByRole("listitem").filter({ hasText: "Limited poster" });
    await expect(poster).toContainText("Only 3 left");
  });

  test("recommendations appear within 2 seconds", async ({ page }) => {
    await page.goto("/");
    const recs = page.getByRole("region", { name: "Recommended for you" }).getByRole("listitem");
    await expect(recs).toHaveCount(3, { timeout: 2_000 });
  });
});

test.describe("cart", () => {
  test("adding a product updates the header count and the cart", async ({ page }) => {
    await addToCart(page, "Blue mug");
    await expect(page.getByRole("link", { name: "Cart (1)" })).toBeVisible();
    await page.getByRole("link", { name: /Cart/ }).click();
    await expect(page.getByRole("row").filter({ hasText: "Blue mug" })).toContainText("€12.00");
    await expect(summary(page).getByTestId("total")).toHaveText("€12.00");
  });

  test("changing the quantity updates the total", async ({ page }) => {
    await addToCart(page, "Blue mug");
    await page.goto("/#/cart");
    const qty = page.getByLabel("Quantity for Blue mug");
    await qty.fill("3");
    await qty.blur();
    await expect(summary(page).getByTestId("total")).toHaveText("€36.00");
  });

  test("a quantity above 99 is refused and the cart does not change", async ({ page }) => {
    await addToCart(page, "Blue mug");
    await page.goto("/#/cart");
    const qty = page.getByLabel("Quantity for Blue mug");
    await qty.fill("100");
    await qty.blur();
    await expect(page.getByRole("status")).toHaveText("Choose a quantity from 1 to 99");
    await expect(summary(page).getByTestId("total")).toHaveText("€12.00");
  });

  test("removing the last product empties the cart", async ({ page }) => {
    await addToCart(page, "Pencil set");
    await page.goto("/#/cart");
    await page.getByRole("button", { name: "Remove Pencil set" }).click();
    await expect(page.getByText("Your cart is empty.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Cart (0)" })).toBeVisible();
  });
});

test.describe("coupons", () => {
  test("SAVE10 takes 10% off", async ({ page }) => {
    await addToCart(page, "Blue mug");
    await page.goto("/#/cart");
    await applyCoupon(page, "SAVE10");
    await expect(summary(page).getByTestId("discount")).toHaveText("−€1.20");
    await expect(summary(page).getByTestId("total")).toHaveText("€10.80");
  });

  test("an unknown code is refused", async ({ page }) => {
    await addToCart(page, "Blue mug");
    await page.goto("/#/cart");
    await applyCoupon(page, "NOPE");
    await expect(page.getByRole("alert")).toHaveText("This coupon code isn't valid");
  });

  test("an expired code is refused", async ({ page }) => {
    await addToCart(page, "Blue mug");
    await page.goto("/#/cart");
    await applyCoupon(page, "SPRING24");
    await expect(page.getByRole("alert")).toHaveText("This coupon has expired");
  });

  test("WELCOME5 is refused below the minimum", async ({ page }) => {
    await addToCart(page, "Pencil set");
    await page.goto("/#/cart");
    await applyCoupon(page, "WELCOME5");
    await expect(page.getByRole("alert")).toHaveText("Spend at least €20.00 to use this coupon");
  });

  test("WELCOME5 takes €5 off above the minimum, sale prices included", async ({ page }) => {
    await addToCart(page, "Desk lamp");
    await page.goto("/#/cart");
    await applyCoupon(page, "WELCOME5");
    await expect(summary(page).getByTestId("total")).toHaveText("€24.90");
  });

  test("a different coupon replaces the one applied", async ({ page }) => {
    await addToCart(page, "Desk lamp");
    await page.goto("/#/cart");
    await applyCoupon(page, "SAVE10");
    await expect(summary(page)).toContainText("Discount (SAVE10)");
    await applyCoupon(page, "WELCOME5");
    await expect(summary(page)).toContainText("Discount (WELCOME5)");
    await expect(summary(page)).not.toContainText("SAVE10");
    await expect(summary(page).getByTestId("total")).toHaveText("€24.90");
  });
});

test.describe("accounts", () => {
  test("signing up logs you in", async ({ page }) => {
    await page.goto("/#/signup");
    await page.getByLabel("Full name").fill("Grace Hopper");
    await page.getByLabel("Email").fill(`grace+${Date.now()}-${test.info().workerIndex}@example.com`);
    await page.getByLabel("Password", { exact: true }).fill("compiler1952");
    await page.getByLabel("Confirm password").fill("compiler1952");
    await page.getByLabel("Date of birth").fill("1906-12-09");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("status")).toHaveText("Welcome, Grace Hopper!");
    await expect(page.getByText("Hi, Grace Hopper")).toBeVisible();
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  });

  test("an empty sign-up shows a problem next to every field", async ({ page }) => {
    await page.goto("/#/signup");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByLabel("Full name")).toHaveAccessibleDescription("Enter your name");
    await expect(page.getByLabel("Email")).toHaveAccessibleDescription("Enter your email address");
    await expect(page.getByLabel("Password", { exact: true })).toHaveAccessibleDescription(
      "Use at least 8 characters, with a letter and a number",
    );
    await expect(page.getByLabel("Date of birth")).toHaveAccessibleDescription("Enter your date of birth");
  });

  test("the passwords must match", async ({ page }) => {
    await page.goto("/#/signup");
    await page.getByLabel("Password", { exact: true }).fill("letters123");
    await page.getByLabel("Confirm password").fill("letters124");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByLabel("Confirm password")).toHaveAccessibleDescription("The passwords don't match");
  });

  test("you must be 18 or older", async ({ page }) => {
    await page.goto("/#/signup");
    await page.getByLabel("Date of birth").fill("2015-06-01");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByLabel("Date of birth")).toHaveAccessibleDescription("You must be 18 or older");
  });

  test("an email can only have one account", async ({ page }) => {
    const { email } = await signUp(page);
    await page.request.post("/api/logout");
    await page.goto("/#/signup");
    await page.getByLabel("Full name").fill("Someone Else");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("another123");
    await page.getByLabel("Confirm password").fill("another123");
    await page.getByLabel("Date of birth").fill("1990-01-01");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByLabel("Email")).toHaveAccessibleDescription("An account with this email already exists");
  });

  test("log-in refuses a wrong password and accepts the right one", async ({ page }) => {
    const { email, password, name } = await signUp(page);
    await page.request.post("/api/logout");
    await page.goto("/#/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(`${password}-wrong`);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("status")).toHaveText(`Welcome back, ${name}!`);
  });
});

test.describe("checkout", () => {
  test("checking out needs you to log in", async ({ page }) => {
    await addToCart(page, "Blue mug");
    await page.goto("/#/checkout");
    await expect(page.getByText("Log in to check out.")).toBeVisible();
  });

  test("an empty cart can't be checked out", async ({ page }) => {
    await signUp(page);
    await page.goto("/#/checkout");
    await expect(page.getByText("Your cart is empty.")).toBeVisible();
  });

  test("placing an order thanks you by name and shows the order", async ({ page }) => {
    await signUp(page, "Ada Lovelace");
    await addToCart(page, "Blue mug");
    await page.goto("/#/checkout");
    await expect(page.getByLabel("Full name")).toHaveValue("Ada Lovelace");
    await page.getByLabel("Address").fill("12 Analytical Row, London");
    await page.getByLabel("Postal code").fill("NW1 2DB");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByRole("heading", { name: "Thank you, Ada Lovelace!" })).toBeVisible();
    await expect(page.getByText(/^Order PW-\d+ is placed\.$/)).toBeVisible();
    await expect(page.getByTestId("order-total")).toHaveText("€12.00");
    await expect(page.getByRole("link", { name: "Cart (0)" })).toBeVisible();
  });

  test("a wrong postal code is refused and the order is not placed", async ({ page }) => {
    await signUp(page);
    await addToCart(page, "Blue mug");
    await page.goto("/#/checkout");
    await page.getByLabel("Address").fill("1 Main Street");
    await page.getByLabel("Postal code").fill("!");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByLabel("Postal code")).toHaveAccessibleDescription("Enter a valid postal code");
    await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
  });
});
