/**
 * The verdict rules, one by one, on made-up proofs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { type CleanResult, type FaultRun, judge, outcomeOf } from "../src/prove/verdict.js";

const SIGNUP = "POST h/api/signup";
const COUPON = "POST h/api/cart/coupon";
const CART = "GET h/api/cart";
const name = (e: string) => e.replace(" h/", " /");

function clean(id: string, calls: Array<[string, boolean]>, extra: Partial<CleanResult> = {}): CleanResult {
  return {
    id,
    title: id,
    file: "tests/a.spec.ts",
    line: 1,
    status: "passed",
    attempts: ["passed"],
    expectedToFail: false,
    calls: calls.map(([endpoint, action]) => ({ endpoint, action })),
    ...extra,
  };
}

/** A fault run: each test's tries, by id. */
function run(kind: FaultRun["kind"], endpoint: string | undefined, results: Record<string, string[]>): FaultRun {
  return {
    kind,
    ...(endpoint ? { endpoints: [endpoint] } : {}),
    results: Object.fromEntries(Object.entries(results).map(([id, attempts]) => [id, { attempts }])),
  };
}

test("outcome: any pass while broken is a miss; only failing every try is caught", () => {
  assert.equal(outcomeOf(["failed"]), "caught");
  assert.equal(outcomeOf(["timedOut"]), "caught");
  assert.equal(outcomeOf(["failed", "passed"]), "missed");
  assert.equal(outcomeOf(["passed"]), "missed");
  assert.equal(outcomeOf(["skipped"]), "not tried");
  assert.equal(outcomeOf(["interrupted"]), "not tried");
  assert.equal(outcomeOf([]), "not tried");
  assert.equal(outcomeOf(undefined), "not tried");
});

test("verdict: a test that passes while its own action fails — even when it catches other faults", () => {
  const [t] = judge(
    [clean("coupon works", [[CART, false], [COUPON, true]])],
    [run("error", COUPON, { "coupon works": ["passed"] }), run("error", CART, { "coupon works": ["failed"] })],
    { name },
  );
  assert.equal(t.verdict, "passes when its own action fails");
  assert.equal(t.reason, "It still passes when POST /api/cart/coupon fails with a server error.");
  assert.deepEqual([t.caught.length, t.missed.length], [1, 1]);
});

test("verdict: catches — every own action's failure fails it; missed reads don't count against it", () => {
  const [t] = judge(
    [clean("checkout", [[CART, false], [COUPON, true]])],
    [run("error", COUPON, { checkout: ["failed"] }), run("empty", CART, { checkout: ["passed"] })],
    { name },
  );
  assert.equal(t.verdict, "catches");
  assert.equal(t.reason, "It fails when POST /api/cart/coupon fails with a server error.");
  assert.equal(t.missed.length, 1);
});

test("verdict: can't fail — nothing broken made it fail", () => {
  const [t] = judge([clean("looks", [[CART, false]])], [run("error", CART, { looks: ["passed"] }), run("empty", CART, { looks: ["passed"] })], { name });
  assert.equal(t.verdict, "can't fail");
  assert.match(t.reason, /^Nothing I broke made it fail: it passed with each of 2 faults/);
});

test("verdict: not proven — marked to fail, failing, flaky, no calls, limited, never ran", () => {
  const verdictOf = (c: CleanResult, runs: FaultRun[], limited = false) => judge([c], runs, { name, limited })[0];
  const broken = [run("error", COUPON, { x: ["failed"] })];

  const marked = verdictOf(clean("x", [[COUPON, true]], { expectedToFail: true }), broken);
  assert.deepEqual([marked.verdict, marked.reason], ["not proven", "It's marked to fail (test.fail), so a failure proves nothing about it."]);

  const failing = verdictOf(clean("x", [[COUPON, true]], { status: "failed", attempts: ["failed"], error: "expect(locator).toBeVisible() failed" }), broken);
  assert.equal(failing.verdict, "not proven");
  assert.match(failing.reason, /^It failed with nothing broken: expect\(locator\)\.toBeVisible\(\) failed\. Fix that first/);

  // Flaky in the clean run, or in any fault run: failed, then passed, with nothing changed.
  assert.match(verdictOf(clean("x", [[COUPON, true]], { status: "flaky", attempts: ["failed", "passed"] }), broken).reason, /it's flaky/);
  const flakyLater = verdictOf(clean("x", [[COUPON, true]]), [run("error", COUPON, { x: ["failed"] }), run("error", SIGNUP, { x: ["failed", "passed"] })]);
  assert.equal(flakyLater.verdict, "not proven");
  assert.match(flakyLater.reason, /failed and then passed with nothing changed \(once\)/);

  // No calls of its own: when a fault elsewhere fails it, it reads another test's result.
  const reader = verdictOf(clean("x", []), [run("error", COUPON, { x: ["failed"] })]);
  assert.equal(reader.reason, "It makes no API calls of its own, so there was nothing of its own to break. It fails when POST /api/cart/coupon fails with a server error: it reads another test's result.");

  assert.equal(verdictOf(clean("x", [[CART, false]]), broken, true).reason, "None of the calls it makes were among the ones you asked me to break.");
  assert.match(verdictOf(clean("x", [[COUPON, true]]), [run("error", COUPON, { x: ["skipped"] })]).reason, /^It never ran with one of its calls broken/);
});

test("verdict: failing on a call it doesn't make is noted — it depends on another test", () => {
  const [t] = judge(
    [clean("checkout", [[COUPON, true]])],
    [run("error", COUPON, { checkout: ["failed"] }), run("error", SIGNUP, { checkout: ["failed"] })],
    { name },
  );
  assert.equal(t.verdict, "catches");
  assert.equal(t.alsoFailed.length, 1);
  assert.match(t.reason, /It also fails when POST \/api\/signup fails with a server error, a call it doesn't make: it depends on another test\.$/);
  // A test that passes a fault elsewhere isn't blamed for it.
  const [u] = judge([clean("u", [[COUPON, true]])], [run("error", COUPON, { u: ["failed"] }), run("error", SIGNUP, { u: ["passed"] })]);
  assert.equal(u.alsoFailed.length, 0);
});

test("verdict: the late-answers run is its own finding, never a catch or a miss", () => {
  const slow: FaultRun = { kind: "slow", endpoints: [COUPON, CART], results: { t: { attempts: ["failed"], error: "Timeout 800ms exceeded", errorAt: "tests/a.spec.ts:9" } } };
  const [t] = judge([clean("t", [[COUPON, true]])], [run("error", COUPON, { t: ["failed"] }), slow], { name });
  assert.equal(t.verdict, "catches");
  assert.deepEqual([t.caught.length, t.missed.length, t.alsoFailed.length], [1, 0, 0]);
  assert.equal(t.slow?.outcome, "caught");
  assert.equal(t.slow?.errorAt, "tests/a.spec.ts:9");
});
