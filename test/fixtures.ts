import type { TestPlan } from "../src/plan/playwright-plan.js";

/** A plan as Playwright's planner would hand it to planner_save_plan. */
export const COUPONS: TestPlan = {
  name: "Checkout coupons",
  overview: "Proofwright Shop: a small web shop.\nCoupons are applied in the cart.",
  suites: [
    {
      name: "Coupons",
      seedFile: "demo/generated/seed.spec.ts",
      tests: [
        {
          name: "A valid coupon lowers the total",
          file: "demo/generated/coupons/valid-coupon.spec.ts",
          steps: [
            { perform: 'Click "Add Blue mug to cart"', expect: ["The header shows Cart (1)"] },
            { perform: "Open the cart", expect: [] },
            {
              perform: 'Type "SAVE10" in the Coupon code field and click Apply',
              expect: ["The discount shows −€1.20", "The total shows €10.80"],
            },
          ],
        },
        {
          name: "An expired coupon is refused",
          file: "demo/generated/coupons/expired-coupon.spec.ts",
          steps: [
            { perform: "Add a Blue mug and open the cart", expect: [] },
            { perform: "Type an expired coupon code and click Apply", expect: ["It works as expected"] },
          ],
        },
        {
          name: "Just clicks around",
          file: "demo/generated/coupons/clicks.spec.ts",
          steps: [{ expect: [] }, { perform: "Open the cart", expect: [] }],
        },
      ],
    },
  ],
};
