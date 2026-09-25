import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestPlan } from "../src/plan/playwright-plan.js";
import { Project } from "../src/project.js";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A throwaway copy of the demo — the shop, its Playwright config and the given
 * test folders — to run Playwright's runner in. Give it a port of its own
 * (SHOP_PORT) so it never meets another run's shop.
 */
export function demoCopy(folders: string[]): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofwright-demo-"));
  for (const rel of ["package.json", "playwright.config.ts", "demo/shop", ...folders]) {
    fs.cpSync(path.join(REPO, rel), path.join(dir, rel), { recursive: true });
  }
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  return new Project(dir);
}

/**
 * A port nothing is listening on, from the operating system — so test files
 * running side by side never start their shops on the same one.
 */
export async function freePort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return String(port);
}

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
