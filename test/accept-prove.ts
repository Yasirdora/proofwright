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
      "user can sign up": "misses its own action",
      "add to cart works": "misses its own action",
      "coupon works": "misses its own action",
      checkout: "catches",
      "order number is shown": "not proven",
      "recommendations › recommendations load": "not proven",
    });
    const own = (title: string) => answer.data.tests.find((t) => t.title === title)!.result;
    assert.equal(own("user can sign up"), 'Stays green when "Create account" (checkout.spec.ts:16) fails.');
    assert.equal(own("add to cart works"), 'Stays green when "#app > ul > li:nth-child(1) > button" (checkout.spec.ts:22) fails.');
    assert.equal(own("coupon works"), 'Stays green when "Apply" (checkout.spec.ts:30) fails.');
    assert.match(own("checkout"), /^Fails when "Log in" fails, or when "Place order" fails/);
    assert.match(own("checkout"), /It also fails when POST \/api\/signup fails, a call it doesn't make: it depends on another test\.$/);
    // Its first tries fail about half the time: with nothing broken it's flaky — or, now and then, fails every try.
    assert.match(own("recommendations › recommendations load"), /passes and fails at random|already fails with nothing broken/);
    process.stdout.write(`\n${answer.headline}\n`);
  } finally {
    delete process.env.SHOP_PORT;
  }
});
