/**
 * The verdict rules, one by one, on made-up proofs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { type CleanResult, type FaultRun, judge, outcomeOf, type StepRef } from "../src/prove/verdict.js";

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
function run(kind: FaultRun["kind"], endpoint: string | undefined, results: Record<string, string[]>, extra: Partial<FaultRun> = {}): FaultRun {
  return {
    kind,
    ...(endpoint ? { endpoints: [endpoint] } : {}),
    applied: true,
    results: Object.fromEntries(Object.entries(results).map(([id, attempts]) => [id, { attempts }])),
    ...extra,
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

test("verdict: a test that stays green while its own step fails — even when it catches other faults", () => {
  const [t] = judge(
    [clean("coupon works", [[CART, false], [COUPON, true]])],
    [run("error", COUPON, { "coupon works": ["passed"] }), run("error", CART, { "coupon works": ["failed"] })],
    { name },
  );
  assert.equal(t.verdict, "misses its own action");
  assert.equal(t.result, "Stays green when POST /api/cart/coupon fails.");
  assert.equal(t.todo, "After that step, check something the page shows only when POST /api/cart/coupon worked.");
  assert.deepEqual([t.caught.length, t.missed.length], [1, 1]);
});

test("verdict: with the trace, the step is named in words a tester knows — and its line", () => {
  const step = (_: string, endpoint: string, nth: number): StepRef | undefined =>
    endpoint === COUPON ? { name: 'click "Apply"', at: `demo/tests/coupons.spec.ts:${nth === 1 ? 30 : 41}` } : undefined;
  const [t] = judge([clean("t", [[COUPON, true]])], [run("error", COUPON, { t: ["passed"] })], { name, step });
  assert.equal(t.result, 'Stays green when "Apply" (coupons.spec.ts:30) fails.');
  assert.equal(t.todo, 'After that step, check something the page shows only when "Apply" worked.');
});

test("verdict: a repeated step answered late and changed — a test that reads the page too early is caught out", () => {
  const step = (_: string, _e: string, nth: number): StepRef => ({ name: 'click "Apply"', at: `demo/tests/c.spec.ts:${nth === 1 ? 30 : 41}` });
  const repeat = (attempts: string[], applied = true): FaultRun => run("changed", COUPON, { early: attempts, other: ["passed"] }, { nth: 2, test: "early", applied });
  const [early, other] = judge(
    [clean("early", [[COUPON, true]]), clean("other", [[COUPON, true]])],
    [run("error", COUPON, { early: ["failed"], other: ["failed"] }), repeat(["passed"])],
    { name, step },
  );
  assert.equal(early.verdict, "misses its own action");
  assert.equal(early.result, 'Stays green when the answers to the 2nd "Apply" (c.spec.ts:41) come late and different: it checks the page before they arrive.');
  assert.equal(early.todo, 'Wait until the page has updated after the 2nd "Apply" before checking it — for example, for a message it shows, or for the data it loads again.');
  // The run was for "early" alone: "other" is judged without it.
  assert.equal(other.verdict, "catches");
  assert.equal(other.missed.length, 0);
  // A test that waits for the answer fails on the changed numbers: it catches.
  assert.equal(judge([clean("early", [[COUPON, true]])], [run("error", COUPON, { early: ["failed"] }), repeat(["failed"])], { name, step })[0].verdict, "catches");
  // A fault that broke nothing (no numbers to change) proves nothing: not tried.
  const [nothing] = judge([clean("early", [[COUPON, true]])], [run("error", COUPON, { early: ["failed"] }), repeat(["passed"], false)], { name, step });
  assert.equal(nothing.verdict, "catches");
  assert.equal(nothing.notTried.length, 1);
});

test("verdict: catches — every own action's failure fails it; missed reads don't count against it", () => {
  const [t] = judge(
    [clean("checkout", [[CART, false], [COUPON, true]])],
    [run("error", COUPON, { checkout: ["failed"] }), run("empty", CART, { checkout: ["passed"] })],
    { name },
  );
  assert.equal(t.verdict, "catches");
  assert.equal(t.result, "Fails when POST /api/cart/coupon fails.");
  assert.equal(t.todo, "");
  assert.equal(t.missed.length, 1);
});

test("verdict: can't fail — nothing broken made it fail", () => {
  const [t] = judge([clean("looks", [[CART, false]])], [run("error", CART, { looks: ["passed"] }), run("empty", CART, { looks: ["passed"] })], { name });
  assert.equal(t.verdict, "can't fail");
  assert.equal(t.result, "Nothing I broke made it fail: it checks nothing its calls change.");
  assert.equal(t.todo, "Add a check on what the page shows after its main step.");
});

test("verdict: not proven — and a test failing with nothing broken is never something to 'fix' to pass", () => {
  const verdictOf = (c: CleanResult, runs: FaultRun[], limited = false) => judge([c], runs, { name, limited })[0];
  const broken = [run("error", COUPON, { x: ["failed"] })];

  const marked = verdictOf(clean("x", [[COUPON, true]], { expectedToFail: true }), broken);
  assert.deepEqual([marked.verdict, marked.result], ["not proven", "Marked to fail (test.fail), so a failure proves nothing about it."]);

  const failing = verdictOf(clean("x", [[COUPON, true]], { status: "failed", attempts: ["failed"], error: 'Expected: "−€1.24" Received: "−€1.23"' }), broken);
  assert.equal(failing.verdict, "not proven");
  assert.equal(failing.result, 'Can\'t be checked: it already fails with nothing broken (Expected: "−€1.24" Received: "−€1.23").');
  assert.equal(failing.todo, "Find out why with explain. If the app is wrong, report the bug — don't change the test to make it pass. Prove it again once it passes.");
  assert.doesNotMatch(failing.todo, /^fix/i);

  // Flaky in the clean run, or in any fault run: failed, then passed, with nothing changed.
  assert.match(verdictOf(clean("x", [[COUPON, true]], { status: "flaky", attempts: ["failed", "passed"] }), broken).result, /passes and fails at random/);
  const flakyLater = verdictOf(clean("x", [[COUPON, true]]), [run("error", COUPON, { x: ["failed"] }), run("error", SIGNUP, { x: ["failed", "passed"] })]);
  assert.equal(flakyLater.verdict, "not proven");
  assert.match(flakyLater.result, /with nothing changed \(once\)/);
  assert.match(flakyLater.todo, /^Make it stable first/);

  // No calls of its own: when a fault elsewhere fails it, it reads another test's result.
  const reader = verdictOf(clean("x", []), [run("error", COUPON, { x: ["failed"] })]);
  assert.equal(reader.result, "Can't be checked alone: it makes no API calls of its own. It fails when POST /api/cart/coupon fails: it reads another test's result.");

  assert.equal(verdictOf(clean("x", [[CART, false]]), broken, true).result, "Not checked: none of its calls were among the ones you asked me to break.");
  assert.match(verdictOf(clean("x", [[COUPON, true]]), [run("error", COUPON, { x: ["skipped"] })]).result, /a test before it in its group failed first/);
});

test("verdict: with no server calls anywhere, a test is simply not checked — never blamed, never \"alone\"", () => {
  const [passes, fails] = judge(
    [clean("passes", []), clean("fails", [], { status: "failed", attempts: ["failed"], error: "Timeout" })],
    [],
    { name, noCalls: true },
  );
  assert.deepEqual([passes.verdict, passes.result, passes.todo], ["not proven", "Not checked: the app made no server calls, so there was nothing to break.", ""]);
  assert.match(fails.result, /^Can't be checked: it already fails with nothing broken/);
  // Without noCalls, a test with no calls in an app that has them reads another test's result.
  assert.match(judge([clean("x", [])], [], { name })[0].result, /^Can't be checked alone/);
});

test("verdict: failing on a call it doesn't make is noted — it depends on another test", () => {
  const [t] = judge(
    [clean("checkout", [[COUPON, true]])],
    [run("error", COUPON, { checkout: ["failed"] }), run("error", SIGNUP, { checkout: ["failed"] })],
    { name },
  );
  assert.equal(t.verdict, "catches");
  assert.equal(t.alsoFailed.length, 1);
  assert.match(t.result, /It also fails when POST \/api\/signup fails, a call it doesn't make: it depends on another test\.$/);
  // A test that passes a fault elsewhere isn't blamed for it.
  const [u] = judge([clean("u", [[COUPON, true]])], [run("error", COUPON, { u: ["failed"] }), run("error", SIGNUP, { u: ["passed"] })]);
  assert.equal(u.alsoFailed.length, 0);
});

test("verdict: the late-answers run is its own finding, never a catch or a miss", () => {
  const slow: FaultRun = { kind: "slow", endpoints: [COUPON, CART], applied: true, results: { t: { attempts: ["failed"], error: "Timeout 800ms exceeded", errorAt: "tests/a.spec.ts:9" } } };
  const [t] = judge([clean("t", [[COUPON, true]])], [run("error", COUPON, { t: ["failed"] }), slow], { name });
  assert.equal(t.verdict, "catches");
  assert.deepEqual([t.caught.length, t.missed.length, t.alsoFailed.length], [1, 0, 0]);
  assert.equal(t.slow?.outcome, "caught");
  assert.equal(t.slow?.errorAt, "tests/a.spec.ts:9");
});
