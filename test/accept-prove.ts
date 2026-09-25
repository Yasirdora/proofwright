/**
 * The acceptance check for prove (spec §8.3): a full proof of the colleague's
 * checkout tests, with the default faults, gives the verdicts in
 * demo/answer-key/REVIEW.md. It runs Playwright's runner 16 times — about four
 * minutes — so it's a script of its own (`npm run accept:prove`), not part of
 * `npm test`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { proveTool } from "../src/prove/tool.js";
import { demoCopy, freePort } from "./fixtures.js";

test("prove on demo/colleague/checkout.spec.ts gives the answer key's verdicts", { timeout: 15 * 60_000 }, async () => {
  const project = demoCopy(["demo/colleague"]);
  process.env.SHOP_PORT = await freePort();
  try {
    const answer = await proveTool(project, { paths: ["demo/colleague/checkout.spec.ts"], project: "colleague" }, (m) => process.stderr.write(`${m}\n`));
    const verdict = Object.fromEntries(answer.data.tests.map((t) => [t.title, t.verdict]));
    assert.deepEqual(verdict, {
      "user can sign up": "passes when its own action fails",
      "add to cart works": "passes when its own action fails",
      "coupon works": "passes when its own action fails",
      checkout: "catches",
      "order number is shown": "not proven",
      "recommendations › recommendations load": "not proven",
    });
    const own = (title: string) => answer.data.tests.find((t) => t.title === title)!.reason;
    assert.equal(own("user can sign up"), "It still passes when POST /api/signup fails with a server error.");
    assert.equal(own("add to cart works"), "It still passes when POST /api/cart/items fails with a server error.");
    assert.equal(own("coupon works"), "It still passes when POST /api/cart/coupon fails with a server error.");
    assert.match(own("checkout"), /^It fails when POST \/api\/login fails with a server error; POST \/api\/orders fails with a server error/);
    assert.match(own("checkout"), /It also fails when POST \/api\/signup fails with a server error, a call it doesn't make: it depends on another test\.$/);
    assert.match(own("recommendations › recommendations load"), /it's flaky/);
    process.stdout.write(`\n${answer.headline}\n`);
  } finally {
    delete process.env.SHOP_PORT;
  }
});
